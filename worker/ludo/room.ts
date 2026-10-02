// One Ludo room per Durable Object: seats, sockets, pacing and the room's telemetry.
// Solo rooms ("s-<hex>") seat one human and three server bots. Code rooms ("c-<CODE>") fill with up to
// four humans; the game starts when all four have joined, or earlier if a seated player asks to fill with bots.
// Every action is server-authoritative and server-timed, so the latency figures are not client claims.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { activeFault } from "../faults";
import { record, type SliEvent } from "../log";
import { apply, autoAction, newGame, SEATS, start, type Action, type Game, type SeatKind } from "./engine";

/** Pacing and patience budgets (docs/ludo-telemetry.md). */
export const BOT_STEP_MS = 700;
export const HUMAN_TURN_MS = 30_000;
export const ACTION_GOOD_MS = 100;
export const RTT_GOOD_MS = 300;
export const BOT_LAG_GOOD_MS = 250;
export const LOBBY_GOOD_MS = 120_000;

const MAX_MSG_BYTES = 256;
const MAX_SOCKETS = 8;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;
const KEY = /^[a-f0-9]{16}$/;

interface Meta {
  mode: "solo" | "code";
  keys: (string | null)[];
  createdAt: number;
  startedAt: number | null;
  turnStartedAt: number;
  due: number | null;
  ended: boolean;
}

interface Attachment {
  seat: number;
  n: number;
  windowStart: number;
}

type Inbound =
  | { t: "roll" }
  | { t: "move"; token: number }
  | { t: "start" }
  | { t: "ping" }
  | { t: "echo"; s: number };

function parse(raw: string | ArrayBuffer): Inbound | null {
  if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case "roll":
    case "start":
    case "ping":
      return { t: o.t };
    case "move":
      return Number.isInteger(o.token) && (o.token as number) >= 0 && (o.token as number) < 4 ? { t: "move", token: o.token as number } : null;
    case "echo":
      return typeof o.s === "number" && Number.isFinite(o.s) ? { t: "echo", s: o.s } : null;
    default:
      return null;
  }
}

export class LudoRoom extends DurableObject<Env> {
  private game: Game | null = null;
  private meta: Meta | null = null;

  private async load(): Promise<void> {
    if (this.game && this.meta) return;
    this.game = (await this.ctx.storage.get<Game>("game")) ?? null;
    this.meta = (await this.ctx.storage.get<Meta>("meta")) ?? null;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put({ game: this.game, meta: this.meta });
  }

  private rec(ev: SliEvent): void {
    record(this.env, ev, this.ctx as unknown as ExecutionContext);
  }

  /** Upgrade from the site Worker, already validated there (origin, room name, key). */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    const key = url.searchParams.get("key") ?? "";
    if (!KEY.test(key)) return new Response("bad key", { status: 400 });
    await this.load();
    const now = Date.now();

    if (!this.game || !this.meta) {
      const mode = room.startsWith("s-") ? "solo" : "code";
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
      const seats: SeatKind[] = mode === "solo" ? ["human", "bot", "bot", "bot"] : ["empty", "empty", "empty", "empty"];
      this.game = newGame(seed, seats);
      this.meta = { mode, keys: [null, null, null, null], createdAt: now, startedAt: null, turnStartedAt: now, due: null, ended: false };
    }
    const g = this.game;
    const m = this.meta;

    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("room busy", { status: 429 });
    let seat = m.keys.indexOf(key);
    if (seat < 0) {
      if (m.mode === "solo") seat = m.keys[0] === null ? 0 : -1;
      else if (g.phase === "lobby") seat = g.seats.indexOf("empty");
      if (seat < 0) return new Response("room full", { status: 409 });
      m.keys[seat] = key;
      if (m.mode === "code") g.seats[seat] = "human";
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat, n: 0, windowStart: now } satisfies Attachment);

    if (g.phase === "lobby") {
      const humans = g.seats.filter((k) => k === "human").length;
      if (m.mode === "solo" || humans === SEATS) this.begin(now);
    } else if (!m.ended && g.phase !== "over") {
      m.turnStartedAt = now; // a returning player gets a fresh turn clock
    }
    await this.save();
    await this.schedule();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  private begin(now: number): void {
    const m = this.meta!;
    this.game = start(this.game!);
    m.startedAt = now;
    m.turnStartedAt = now;
    if (m.mode === "code") {
      const wait = now - m.createdAt;
      this.rec({ op: "ludo_lobby", outcome: wait <= LOBBY_GOOD_MS ? "ok" : "degraded", status: 200, ms: wait, detail: `humans=${this.game.seats.filter((k) => k === "human").length}` });
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const t0 = Date.now();
    const att = ws.deserializeAttachment() as Attachment;
    if (t0 - att.windowStart > RATE_WINDOW_MS) {
      att.n = 0;
      att.windowStart = t0;
    }
    att.n += 1;
    ws.serializeAttachment(att);
    if (att.n > RATE_MAX) {
      ws.close(1008, "rate");
      return;
    }
    const msg = parse(raw);
    if (!msg) return this.send(ws, { t: "err", code: "bad_message" });

    if (msg.t === "ping") return this.send(ws, { t: "probe", s: t0 });
    if (msg.t === "echo") {
      const rtt = t0 - msg.s;
      if (rtt >= 0 && rtt <= 60_000) this.rec({ op: "ludo_rtt", outcome: rtt <= RTT_GOOD_MS ? "ok" : "degraded", status: 200, ms: rtt });
      return;
    }

    await this.load();
    const g = this.game;
    const m = this.meta;
    if (!g || !m) return this.send(ws, { t: "err", code: "no_game" });

    if (msg.t === "start") {
      if (g.phase !== "lobby") return this.send(ws, { t: "err", code: "already_started" });
      g.seats = g.seats.map((k) => (k === "empty" ? "bot" : k));
      this.begin(t0);
    } else {
      const action: Action = msg.t === "roll" ? { seat: att.seat, kind: "roll" } : { seat: att.seat, kind: "move", token: msg.token };
      try {
        this.game = this.step(g, action);
      } catch (e) {
        // A rejected action is the player's mistake (or a stale screen), not a server failure: logged, not an SLI.
        console.log(JSON.stringify({ v: 1, ts: new Date().toISOString(), op: "ludo_invalid", detail: e instanceof Error ? e.message : "invalid" }));
        return this.send(ws, { t: "err", code: e instanceof Error ? e.message : "invalid" });
      }
    }

    if (activeFault(this.env) === "ludo_slow") await new Promise((r) => setTimeout(r, 400));
    await this.save();
    await this.schedule();
    this.broadcast();
    const ms = Date.now() - t0;
    this.rec({
      op: "ludo_action",
      outcome: ms <= ACTION_GOOD_MS ? "ok" : "degraded",
      status: 200,
      ms,
      detail: `human ${msg.t}`,
      fault: activeFault(this.env),
    });
  }

  /** Apply an action and, when the turn changes hands, restart the turn clock. Auto-move a single legal choice. */
  private step(g: Game, a: Action): Game {
    const before = g.turn;
    let out = apply(g, a);
    if (out.phase === "move" && out.legal.length === 1 && out.seats[out.turn] === "human") {
      out = apply(out, { seat: out.turn, kind: "move", token: out.legal[0]! });
    }
    if (out.turn !== before || out.phase === "roll") this.meta!.turnStartedAt = Date.now();
    if (out.phase === "over") this.finish(out);
    return out;
  }

  private finish(g: Game): void {
    const m = this.meta!;
    if (m.ended) return;
    m.ended = true;
    const humans = g.seats.filter((k) => k === "human").length;
    this.rec({ op: "ludo_game", outcome: "ok", status: 200, ms: Date.now() - (m.startedAt ?? m.createdAt), detail: `${m.mode} humans=${humans} winner=${g.seats[g.winner ?? 0]} actions=${g.log.length}` });
  }

  /** One alarm drives bots and turn timeouts. `due` is kept so alarm lateness is measured, not assumed. */
  private async schedule(): Promise<void> {
    const g = this.game!;
    const m = this.meta!;
    const live = this.ctx.getWebSockets().length > 0;
    if (!live || g.phase === "lobby" || g.phase === "over") {
      m.due = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = g.seats[g.turn] === "bot" ? Date.now() + BOT_STEP_MS : m.turnStartedAt + HUMAN_TURN_MS;
    m.due = due;
    await this.ctx.storage.put("meta", m);
    await this.ctx.storage.setAlarm(due);
  }

  async alarm(): Promise<void> {
    const t0 = Date.now();
    await this.load();
    const g = this.game;
    const m = this.meta;
    if (!g || !m || g.phase === "lobby" || g.phase === "over") return;
    const lag = m.due === null ? 0 : Math.max(0, t0 - m.due);
    const isBot = g.seats[g.turn] === "bot";
    if (!isBot && t0 < m.turnStartedAt + HUMAN_TURN_MS) return this.schedule();

    const [action, drawn] = autoAction(g);
    this.game = this.step(drawn, action);
    await this.save();
    await this.schedule();
    this.broadcast();
    const ms = Date.now() - t0 + lag;
    if (isBot) {
      this.rec({ op: "ludo_action", outcome: ms <= BOT_LAG_GOOD_MS ? "ok" : "degraded", status: 200, ms, detail: `bot ${action.kind} lag=${lag}` });
    } else {
      // A human ran out of patience or left: an engagement signal, not a server fault.
      console.log(JSON.stringify({ v: 1, ts: new Date().toISOString(), op: "ludo_timeout", detail: `${m.mode} seat=${action.seat}` }));
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
    await this.load();
    const g = this.game;
    const m = this.meta;
    if (!g || !m) return;
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length > 0) return;
    if (g.phase === "lobby" && m.mode === "code") {
      this.rec({ op: "ludo_lobby", outcome: "degraded", status: 200, ms: Date.now() - m.createdAt, detail: `abandoned humans=${g.seats.filter((k) => k === "human").length}` });
    } else if (g.phase !== "over" && !m.ended) {
      m.ended = true;
      this.rec({ op: "ludo_game", outcome: "degraded", status: 200, ms: Date.now() - (m.startedAt ?? m.createdAt), detail: `${m.mode} abandoned actions=${g.log.length}` });
    }
    m.due = null;
    await this.ctx.storage.deleteAlarm();
    await this.save();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private send(ws: WebSocket, body: unknown): void {
    try {
      ws.send(JSON.stringify(body));
    } catch {
      // A socket that died mid-send is cleaned up by webSocketClose.
    }
  }

  private broadcast(): void {
    const g = this.game!;
    const m = this.meta!;
    const view = {
      seats: g.seats,
      tokens: g.tokens,
      turn: g.turn,
      phase: g.phase,
      die: g.die,
      legal: g.legal,
      winner: g.winner,
      moves: g.log.length,
      mode: m.mode,
      turnEndsAt: g.seats[g.turn] === "human" && g.phase !== "over" && g.phase !== "lobby" ? m.turnStartedAt + HUMAN_TURN_MS : null,
    };
    for (const ws of this.ctx.getWebSockets()) {
      const { seat } = ws.deserializeAttachment() as Attachment;
      this.send(ws, { t: "state", you: seat, g: view });
    }
  }
}
