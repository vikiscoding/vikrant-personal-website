// One Ludo room per Durable Object: seats, sockets, pacing and the room's telemetry.
// Solo rooms ("s-<hex>") seat one human and three server bots. Code rooms ("c-<CODE>") fill with up to
// four humans; the game starts when all four have joined, or earlier if a seated player asks to fill with bots.
// Every action is server-authoritative and server-timed, so the latency figures are not client claims.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { isCapacity, nextReset } from "../capacity";
import { activeFault } from "../faults";
import type { LedgerEntry } from "../ledger";
import { logUnrecorded, record, type SliEvent } from "../log";
import { detail } from "./telemetry";
import { cleanChat, cleanName } from "./text";
import { apply, autoAction, bestMove, endWithoutHumans, newGame, SEATS, start, type Action, type Game, type SeatKind } from "./engine";

/** Pacing and patience budgets (docs/ludo-telemetry.md). */
export const BOT_STEP_MS = 700;
/** Each prompt (roll, then move) gives a human this long; then the server acts for them, sensibly, and play goes on. */
export const HUMAN_PROMPT_MS = 15_000;
export const ACTION_GOOD_MS = 100;
export const RTT_GOOD_MS = 300;
export const BOT_LAG_GOOD_MS = 250;
export const LOBBY_GOOD_MS = 120_000;
/** Everyone disconnected mid-game without pressing Leave (tabs closed, phones asleep): this long to come back, then
 *  the game ends as if they had left (owner's call, 4 Oct 2026). Pressing Leave ends it at once. */
export const EMPTY_GRACE_MS = 60_000;
/** A player away from a friends' game this long gives their seat back to the bot for good: name cleared, seat free
 *  for the next late joiner (owner, 5 Oct 2026). Back sooner, from the same tab, and the seat is still theirs. */
export const AWAY_RELEASE_MS = 120_000;

/** Room chat can carry 200 characters in any script; joined emoji and combining marks make that up to ~4 KB of JSON. */
const MAX_MSG_BYTES = 4096;
/** Room chat (code rooms only): kept in the room's storage only, cleared with the names when the room empties. */
const CHAT_KEEP = 30;
const CHAT_WINDOW_MS = 10_000;
const CHAT_MAX_PER_WINDOW = 5;
const CHAT_MIN_GAP_MS = 600;
const MAX_SOCKETS = 8;
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;
const KEY = /^[a-f0-9]{16}$/;
export interface ChatLine {
  id: number;
  /** -1 for a line the room itself writes (a player taking over a bot's seat). */
  seat: number;
  /** The sender's name (or colour) when they wrote it. */
  name: string;
  text: string;
  at: number;
  system?: true;
}

interface Meta {
  mode: "solo" | "code";
  keys: (string | null)[];
  createdAt: number;
  startedAt: number | null;
  turnStartedAt: number;
  /** When the current seat was last asked for input (state pushed): think time starts here. */
  promptAt?: number;
  due: number | null;
  ended: boolean;
  /** Optional display names per seat; cleared when the last player leaves. */
  names?: (string | null)[];
  /** Room chat, newest last, at most CHAT_KEEP lines; cleared when the last player leaves. */
  chat?: ChatLine[];
  chatSeq?: number;
  /** The bot steps since the turn last left a human: one ludo_bot event when it reaches a human again. Kept in the
   *  state record (already written every step), so a room paused between alarms loses nothing. */
  botRun?: { steps: number; worst: number; late: number };
  /** Seats just taken over from a bot, waiting for the newcomer's name before the room announces it. */
  takeover?: number[];
  /** Per seat: when its player was last seen leaving (no open connection), while a bot plays for them. */
  awaySince?: (number | null)[];
  /** When the last person disconnected mid-game; cleared when someone comes back within EMPTY_GRACE_MS. */
  emptySince?: number;
  /** The game ended because everyone left: the room keeps only this, and the link says the game has ended. */
  closed?: { at: number; reason: "left" | "idle" };
}

/** Everything about a room except its move log, stored as ONE record. */
interface State {
  game: Game | null;
  meta: Meta | null;
  tq: LedgerEntry[];
}

interface Attachment {
  seat: number;
  n: number;
  windowStart: number;
  /** Chat rate limit: messages in the current window, and the time of the last one. */
  chatN?: number;
  chatWindow?: number;
  chatLast?: number;
}

type Inbound =
  | { t: "roll" }
  | { t: "move"; token: number }
  | { t: "start" }
  | { t: "rematch" }
  | { t: "leave" }
  | { t: "ping" }
  | { t: "echo"; s: number }
  | { t: "name"; name: string | null }
  | { t: "say"; text: string };

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
    case "rematch":
    case "leave":
    case "roll":
    case "start":
    case "ping":
      return { t: o.t };
    case "move":
      return Number.isInteger(o.token) && (o.token as number) >= 0 && (o.token as number) < 4 ? { t: "move", token: o.token as number } : null;
    case "say": {
      const text = cleanChat(o.text);
      return text ? { t: "say", text } : null;
    }
    case "name": {
      if (o.name === null || o.name === "") return { t: "name", name: null };
      const name = cleanName(o.name);
      return name ? { t: "name", name } : null;
    }
    case "echo":
      return typeof o.s === "number" && Number.isFinite(o.s) ? { t: "echo", s: o.s } : null;
    default:
      return null;
  }
}

/** The seat that threw the most recent die (the turn may already have passed on). */
function lastRoller(g: Game): number | null {
  for (let i = g.log.length - 1; i >= 0; i--) if (g.log[i]!.kind === "roll") return g.log[i]!.seat;
  return null;
}

/** Telemetry is sent to the shared SLI ledger in batches: at this many events, or once the oldest is this old. */
const FLUSH_EVENTS = 25;
const FLUSH_AGE_MS = 20_000;
/** Storage puts take at most 128 keys. */
const PUT_CHUNK = 128;
const logKey = (i: number) => `log:${String(i).padStart(6, "0")}`;

/**
 * The room has no seat left: four people are playing, or the bots' seats are all finished. Say so on a socket and
 * close, rather than refuse the upgrade, which a browser can only report as a dead connection (and retry). Nobody
 * already seated is ever moved to make room. The header tells the route to log it as "full".
 */
function fullSocket(reason: "full" | "over" | "ended"): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify({ t: "full", reason }));
  server.close(4409, "full");
  return new Response(null, { status: 101, webSocket: client, headers: { "x-ludo-result": reason === "ended" ? "ended" : "full" } });
}

/**
 * A friends' game already in play: the seat a late joiner takes. Bots only, never one that has finished; a bot whose
 * turn it is not comes first, so a newcomer does not land mid-move. Lowest seat breaks ties.
 */
function botSeatFor(g: Game): number {
  const done = g.finished ?? [];
  const open = g.seats.map((k, s) => (k === "bot" && !done.includes(s) ? s : -1)).filter((s) => s >= 0);
  return open.find((s) => s !== g.turn) ?? open[0] ?? -1;
}

const COLOUR = ["Red", "Green", "Yellow", "Blue"];

/** Answer an upgrade with a socket that only says "resting until <reset>" and closes (no storage needed). */
export function restingSocket(): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  server.send(JSON.stringify({ t: "resting", resetAt: nextReset() }));
  server.close(1013, "capacity");
  return new Response(null, { status: 101, webSocket: client });
}

export class LudoRoom extends DurableObject<Env> {
  private game: Game | null = null;
  private meta: Meta | null = null;
  /** How many log entries are already stored as rows (append-only; the game record itself is stored without its log). */
  private savedLog = 0;
  /** This room's telemetry not yet sent to the ledger, and when the oldest of it was recorded. */
  private tq: LedgerEntry[] = [];
  private tqSince = 0;
  /** Loaded from the old three-key layout; removed on the next save. */
  private legacy = false;

  private async load(): Promise<void> {
    if (this.game && this.meta) return;
    const state = await this.ctx.storage.get<State>("state");
    if (state) {
      this.game = state.game;
      this.meta = state.meta;
      this.tq = state.tq ?? [];
      this.legacy = false;
    } else {
      // Rooms saved before the single state record kept three keys; read them, and fold them in on the next save.
      this.game = (await this.ctx.storage.get<Game>("game")) ?? null;
      this.meta = (await this.ctx.storage.get<Meta>("meta")) ?? null;
      this.tq = (await this.ctx.storage.get<LedgerEntry[]>("tq")) ?? [];
      this.legacy = this.game !== null || this.meta !== null;
    }
    this.tqSince = this.tq.length ? Date.now() : 0;
    if (!this.game) return;
    if (this.game.log.length > 0) {
      // A game saved before the append-only log: keep it, and write its entries as rows on the next save.
      this.savedLog = 0;
      return;
    }
    const rows = await this.ctx.storage.list<Action>({ prefix: "log:" });
    this.game = { ...this.game, log: [...rows.values()] };
    this.savedLog = rows.size;
  }

  /**
   * Writes are the scarce resource (the Free plan allows 100,000 rows a day for the whole account), so a step costs
   * about two rows: ONE state record (game without its log, room settings, unsent telemetry) and ONE appended log row
   * per action. The log is never rewritten; it would be up to ~50 KB by the end of a game.
   */
  private async persistState(): Promise<void> {
    const g = this.game;
    await this.ctx.storage.put("state", { game: g ? { ...g, log: [] } : null, meta: this.meta, tq: this.tq } satisfies State);
    if (this.legacy) {
      await this.ctx.storage.delete(["game", "meta", "tq"]);
      this.legacy = false;
    }
  }

  private async save(): Promise<void> {
    const g = this.game;
    if (!g) return this.persistState();
    if (g.log.length < this.savedLog) {
      // A rematch started a new log: clear the old rows first.
      const old = [...(await this.ctx.storage.list({ prefix: "log:" })).keys()];
      for (let i = 0; i < old.length; i += PUT_CHUNK) await this.ctx.storage.delete(old.slice(i, i + PUT_CHUNK));
      this.savedLog = 0;
    }
    const rows: Record<string, Action> = {};
    for (let i = this.savedLog; i < g.log.length; i++) rows[logKey(i)] = g.log[i]!;
    const keys = Object.keys(rows);
    for (let i = 0; i + PUT_CHUNK - 1 < keys.length; i += PUT_CHUNK) {
      // Only a legacy game being converted has more rows than one put can carry.
      await this.ctx.storage.put(Object.fromEntries(keys.slice(i, i + PUT_CHUNK).map((k) => [k, rows[k]])));
      for (const k of keys.slice(i, i + PUT_CHUNK)) delete rows[k];
    }
    if (keys.length) await this.ctx.storage.put(rows);
    await this.persistState();
    this.savedLog = g.log.length;
  }

  /** Log the event now (Workers Logs, per event, as before); send it to the shared ledger in this room's next batch. */
  private rec(ev: SliEvent): void {
    record(this.env, ev);
    this.tq.push({
      ts: new Date().toISOString(),
      source: ev.op as LedgerEntry["source"],
      outcome: ev.outcome,
      status: ev.status,
      ms: ev.ms,
      dep: ev.dep ?? "none",
      detail: ev.detail ?? "",
      fault: ev.fault ?? "none",
    });
    if (this.tq.length === 1) this.tqSince = Date.now();
    // Buffered in memory; it is stored with the next state write (no extra row per event). See keepTelemetry().
    if (this.tq.length >= FLUSH_EVENTS || Date.now() - this.tqSince >= FLUSH_AGE_MS) this.flush();
  }

  /**
   * Scale: one ledger call per batch instead of one per event, so the single shared ledger sees load in proportion to
   * active rooms, not to moves. Never blocks or fails the game: a failed send is put back for the next batch.
   */
  private flush(): void {
    if (!this.tq.length || !this.env.LEDGER) return;
    const batch = this.tq.splice(0);
    this.tqSince = 0;
    void this.persistState().catch(() => undefined); // one row per batch, so a reload never re-sends it
    const stub = this.env.LEDGER.get(this.env.LEDGER.idFromName("sli"));
    this.ctx.waitUntil(
      // Refused (capacity or outage): log each entry as unrecorded; the ledger backfill replays them on restore.
      // Not re-queued here, so there is exactly one way back for every event and none is counted twice.
      Promise.resolve(stub.addBatch(batch)).catch((e) => logUnrecorded(batch, e)),
    );
  }

  // ── Capacity guard ────────────────────────────────────────────────────────────────
  // When Cloudflare refuses storage because the Free plan's daily allowance is used up, players get a plain message
  // with the reset time instead of a dead socket, and the room stops (no alarm). It is never recorded as a failure:
  // capacity is a budget, not a fault, and nothing here feeds the incident desk.

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handleFetch(request);
    } catch (e) {
      if (!isCapacity(e)) throw e;
      return restingSocket();
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleMessage(ws, raw);
      this.keepTelemetry();
    } catch (e) {
      if (!isCapacity(e)) throw e;
      this.rest();
    }
  }

  async alarm(): Promise<void> {
    try {
      await this.handleAlarm();
      this.keepTelemetry();
    } catch (e) {
      if (!isCapacity(e)) throw e;
      this.rest();
    }
  }

  /** Tell everyone in the room why play stopped and when it can resume, then close their sockets. */
  private rest(): void {
    const msg = JSON.stringify({ t: "resting", resetAt: nextReset() });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
        ws.close(1013, "capacity");
      } catch {
        // Already gone.
      }
    }
    console.log(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "ludo_capacity", detail: "free-tier allowance used up; room resting" }));
  }

  /**
   * Telemetry rides on the next state write. When the room is about to wait on a person (who may think long enough
   * for the room to be paused), store it now: one row, only at those moments, instead of one row per event.
   */
  private keepTelemetry(): void {
    const g = this.game;
    if (!this.tq.length || !g) return;
    const waitingOnPerson = g.phase === "lobby" || g.phase === "over" || g.seats[g.turn] === "human";
    if (waitingOnPerson) void this.persistState().catch(() => undefined);
  }

  /** Upgrade from the site Worker, already validated there (origin, room name, key). */
  private async handleFetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    const key = url.searchParams.get("key") ?? "";
    if (!KEY.test(key)) return new Response("bad key", { status: 400 });
    await this.load();
    const now = Date.now();
    if (this.meta?.closed) return fullSocket("ended");
    if (this.meta?.emptySince !== undefined && this.game) {
      // Back within the grace period: the game resumes. Too late (the alarm can run behind): it has ended.
      if (now - this.meta.emptySince > EMPTY_GRACE_MS) {
        await this.closeGame("idle");
        return fullSocket("ended");
      }
      this.meta.emptySince = undefined;
    }

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
      // Late to a friends' game (owner's request, 4 Oct 2026): take over a bot's seat, its tokens as they stand.
      const playing = g.phase === "roll" || g.phase === "move";
      if (m.mode === "solo") seat = m.keys[0] === null ? 0 : -1;
      else if (g.phase === "lobby") seat = g.seats.indexOf("empty");
      else if (playing) seat = botSeatFor(g);
      if (seat < 0) {
        if (m.mode === "solo") return new Response("room full", { status: 409 });
        return fullSocket(g.phase === "over" ? "over" : "full");
      }
      if (m.mode === "code" && playing) {
        if (g.turn === seat) this.endBotRun(); // a run of bot turns ends when a person holds the seat
        (m.names ??= [null, null, null, null])[seat] = null;
        m.takeover = [...(m.takeover ?? []).filter((s) => s !== seat), seat];
      }
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
      m.promptAt = now; // a returning player gets a fresh clock
      if (m.awaySince?.[seat]) {
        m.awaySince[seat] = null;
        this.say(`${this.seatName(seat)} is back`);
      }
    }
    await this.schedule();
    await this.save();
    this.broadcast();
    if (m.mode === "code") this.send(server, { t: "chat", lines: m.chat ?? [], replace: true }); // history for a (re)joining player
    return new Response(null, { status: 101, webSocket: client });
  }

  private begin(now: number): void {
    const m = this.meta!;
    this.game = start(this.game!);
    m.startedAt = now;
    m.turnStartedAt = now;
    m.promptAt = now;
    if (m.mode === "code") {
      const wait = now - m.createdAt;
      const seats = this.game.seats;
      this.rec({
        op: "ludo_lobby",
        outcome: wait <= LOBBY_GOOD_MS ? "ok" : "degraded",
        status: 200,
        ms: wait,
        detail: detail({ result: "started", humans: seats.filter((k) => k === "human").length, bots: seats.filter((k) => k === "bot").length }),
      });
    }
  }

  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
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
    if (msg.t === "leave") return this.leaveSeat(ws, att.seat);
    if (msg.t === "say") {
      await this.load();
      const m = this.meta;
      if (!m || m.mode !== "code") return this.send(ws, { t: "err", code: "no_chat_here" });
      const windowStart = att.chatWindow ?? 0;
      const inWindow = t0 - windowStart <= CHAT_WINDOW_MS ? (att.chatN ?? 0) : 0;
      if (inWindow >= CHAT_MAX_PER_WINDOW || t0 - (att.chatLast ?? 0) < CHAT_MIN_GAP_MS) return this.send(ws, { t: "err", code: "slow_down" });
      att.chatN = inWindow + 1;
      att.chatWindow = inWindow === 0 ? t0 : windowStart;
      att.chatLast = t0;
      ws.serializeAttachment(att);
      const seq = (m.chatSeq ?? 0) + 1;
      const line: ChatLine = { id: seq, seat: att.seat, name: m.names?.[att.seat] ?? ["Red", "Green", "Yellow", "Blue"][att.seat]!, text: msg.text, at: t0 };
      m.chatSeq = seq;
      m.chat = [...(m.chat ?? []), line].slice(-CHAT_KEEP);
      await this.persistState();
      // Chat is content people wrote: it goes to the room and its storage only, never to telemetry or logs.
      for (const s of this.ctx.getWebSockets()) this.send(s, { t: "chat", lines: [line] });
      return;
    }
    if (msg.t === "name") {
      await this.load();
      if (!this.meta) return;
      const names = this.meta.names ?? [null, null, null, null];
      names[att.seat] = msg.name;
      this.meta.names = names;
      this.announceTakeover(att.seat);
      await this.persistState();
      this.broadcast();
      return;
    }
    if (msg.t === "echo") {
      const rtt = t0 - msg.s;
      if (rtt >= 0 && rtt <= 60_000) {
        await this.load();
        this.rec({ op: "ludo_rtt", outcome: rtt <= RTT_GOOD_MS ? "ok" : "degraded", status: 200, ms: rtt, detail: detail({ mode: this.meta?.mode ?? "unknown" }) });
      }
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
    } else if (msg.t === "rematch") {
      // Same room, same seats and names, a fresh seed. Only once the game is over, so nobody loses a live game.
      if (g.phase !== "over") return this.send(ws, { t: "err", code: "game_in_progress" });
      const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
      this.game = start(newGame(seed, g.seats));
      m.startedAt = t0;
      m.turnStartedAt = t0;
      m.promptAt = t0;
      m.ended = false;
    } else {
      this.announceTakeover(att.seat); // a page that never sent a name still gets announced, by colour
      const action: Action = msg.t === "roll" ? { seat: att.seat, kind: "roll" } : { seat: att.seat, kind: "move", token: msg.token };
      const think = g.turn === att.seat && m.promptAt ? t0 - m.promptAt : null;
      try {
        this.game = this.step(g, action);
      } catch (e) {
        // A rejected action is the player's mistake (or a stale screen), not a server failure: logged, not an SLI.
        console.log(JSON.stringify({ v: 2, ts: new Date().toISOString(), op: "ludo_invalid", detail: e instanceof Error ? e.message : "invalid" }));
        return this.send(ws, { t: "err", code: e instanceof Error ? e.message : "invalid" });
      }
      if (think !== null && think >= 0) {
        this.rec({ op: "ludo_turn", outcome: "ok", status: 200, ms: think, detail: detail({ mode: m.mode, result: "acted", kind: msg.t }) });
      }
    }

    if (activeFault(this.env) === "ludo_slow") await new Promise((r) => setTimeout(r, 400));
    await this.schedule();
    await this.save();
    this.broadcast();
    const ms = Date.now() - t0;
    this.rec({
      op: "ludo_action",
      outcome: ms <= ACTION_GOOD_MS ? "ok" : "degraded",
      status: 200,
      ms,
      detail: detail({ mode: m.mode, kind: msg.t === "rematch" ? "start" : msg.t }),
      fault: activeFault(this.env),
    });
  }

  /**
   * A player leaves on purpose. In a friends' room a bot takes a playing seat at once, so the others carry on at full
   * pace (a seat in the lobby is simply freed). The socket then closes; if nobody is left, `webSocketClose` stops the
   * room: no alarm, no bots playing to an empty room.
   */
  private async leaveSeat(ws: WebSocket, seat: number): Promise<void> {
    await this.load();
    const g = this.game;
    const m = this.meta;
    const alone = this.ctx.getWebSockets().filter((s) => s !== ws).length === 0;
    if (g && m && alone && (g.phase === "roll" || g.phase === "move")) {
      // The last person in the room pressed Leave mid-game: end it now, rather than hand the seat to a bot and store
      // a game nobody will finish (owner's call, 4 Oct 2026).
      await this.closeGame("left");
    } else if (g && m && m.mode === "code" && g.seats[seat] === "human") {
      const playing = g.phase === "roll" || g.phase === "move";
      const finished = (g.finished ?? []).includes(seat);
      if (g.phase === "lobby") g.seats[seat] = "empty";
      else if (playing && !finished) g.seats[seat] = "bot";
      if (g.phase === "lobby" || (playing && !finished)) {
        m.keys[seat] = null;
        if (m.names) m.names[seat] = null;
        if (playing && g.turn === seat) m.promptAt = Date.now();
        // If that was the last human still playing, stop: bots do not play on for the places. When nobody has
        // finished, everyone left, so the room is left to webSocketClose, which records the game as abandoned.
        if (playing && (g.finished ?? []).length > 0) {
          this.game = endWithoutHumans(g);
          if (this.game.phase === "over") {
            this.endBotRun();
            this.finish(this.game);
          }
        }
        await this.schedule();
        await this.save();
        this.broadcast();
      }
    }
    try {
      ws.close(1000, "left");
    } catch {
      // The browser closed first; webSocketClose does the rest.
    }
  }

  /** Apply an action and, when the turn changes hands, restart the turn clock. Auto-move a single legal choice. */
  private step(g: Game, a: Action): Game {
    const before = g.turn;
    let out = apply(g, a);
    // No pointless taps: if every legal token sits on the same square, the choice cannot matter, so make it.
    const mine = out.tokens[out.turn] ?? [];
    const distinct = new Set(out.legal.map((t) => mine[t]));
    if (out.phase === "move" && distinct.size === 1 && out.seats[out.turn] === "human") {
      out = apply(out, { seat: out.turn, kind: "move", token: out.legal[0]! });
    }
    const now = Date.now();
    if (out.turn !== before || out.phase === "roll") this.meta!.turnStartedAt = now;
    this.meta!.promptAt = now;
    if (out.phase === "over") this.finish(out);
    return out;
  }

  private finish(g: Game): void {
    const m = this.meta!;
    if (m.ended) return;
    m.ended = true;
    const humans = g.seats.filter((k) => k === "human").length;
    this.rec({
      op: "ludo_game",
      outcome: "ok",
      status: 200,
      ms: Date.now() - (m.startedAt ?? m.createdAt),
      detail: detail({ mode: m.mode, result: "won", humans, winner: g.seats[g.winner ?? 0] ?? "unknown", actions: g.log.length }),
    });
    this.flush();
  }

  /** One alarm drives bots and turn timeouts. `due` is kept so alarm lateness is measured, not assumed. */
  /** Seats with an open connection right now (`leaving` is a socket being closed, not yet gone from the list). */
  private connectedSeats(leaving?: WebSocket): Set<number> {
    const out = new Set<number>();
    for (const s of this.ctx.getWebSockets()) {
      if (s === leaving) continue;
      out.add((s.deserializeAttachment() as Attachment).seat);
    }
    return out;
  }

  /**
   * A human seat with nobody connected to it. A late joiner who closed the tab, or a friend whose phone dropped,
   * left every turn waiting out two 15-second prompts (owner's game, 5 Oct 2026). Now a bot plays that seat at bot
   * pace, with the sensible move, until they come back; the seat stays theirs.
   */
  private isAway(seat: number, leaving?: WebSocket): boolean {
    return this.game!.seats[seat] === "human" && !this.connectedSeats(leaving).has(seat);
  }

  private async schedule(leaving?: WebSocket): Promise<void> {
    const g = this.game!;
    const m = this.meta!;
    const live = this.ctx.getWebSockets().filter((s) => s !== leaving).length > 0;
    if (!live || g.phase === "lobby" || g.phase === "over") {
      m.due = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const botPace = g.seats[g.turn] === "bot" || this.isAway(g.turn, leaving);
    const due = botPace ? Date.now() + BOT_STEP_MS : (m.promptAt ?? m.turnStartedAt) + HUMAN_PROMPT_MS;
    m.due = due;
    await this.ctx.storage.setAlarm(due);
  }

  private async handleAlarm(): Promise<void> {
    const t0 = Date.now();
    await this.load();
    if (this.tq.length && t0 - this.tqSince >= FLUSH_AGE_MS) this.flush();
    const g = this.game;
    const m = this.meta;
    if (m?.emptySince !== undefined && this.ctx.getWebSockets().length === 0) {
      // Nobody came back in time. (A woken room with no sockets plays no bot turns.)
      if (t0 >= m.emptySince + EMPTY_GRACE_MS) await this.closeGame("idle");
      else await this.ctx.storage.setAlarm(m.emptySince + EMPTY_GRACE_MS);
      return;
    }
    if (!g || !m || g.phase === "lobby" || g.phase === "over") return;
    const lag = m.due === null ? 0 : Math.max(0, t0 - m.due);
    this.releaseAwaySeats(t0);
    const isBot = g.seats[g.turn] === "bot";
    const away = !isBot && this.isAway(g.turn);
    const promptAt = m.promptAt ?? m.turnStartedAt;
    if (!isBot && !away && t0 < promptAt + HUMAN_PROMPT_MS) return this.schedule();

    // Bots play a seeded random legal move (the original spec). An idle human gets the best move instead:
    // the game keeps going for as long as their tab stays connected, and they would rather not be played badly.
    let action: Action;
    if (isBot) {
      const [a, drawn] = autoAction(g);
      action = a;
      this.game = this.step(drawn, a);
    } else {
      action = g.phase === "roll" ? { seat: g.turn, kind: "roll" } : { seat: g.turn, kind: "move", token: bestMove(g) };
      this.game = this.step(g, action);
    }
    if (isBot) {
      // Measured before the save, which the next state write carries: alarm lateness plus the step's own work.
      const ms = Date.now() - t0 + lag;
      const run = m.botRun ?? { steps: 0, worst: 0, late: 0 };
      m.botRun = { steps: run.steps + 1, worst: Math.max(run.worst, ms), late: run.late + (ms > BOT_LAG_GOOD_MS ? 1 : 0) };
      const g2 = this.game;
      if (g2.phase === "over" || g2.seats[g2.turn] !== "bot") this.endBotRun();
    }
    await this.schedule();
    await this.save();
    this.broadcast();
    if (!isBot && !away) {
      // A human ran out of patience or left: an engagement signal, not a server fault.
      this.rec({ op: "ludo_turn", outcome: "degraded", status: 200, ms: t0 - promptAt, detail: detail({ mode: m.mode, result: "timeout", kind: action.kind }) });
    }
  }

  /** The game's one ludo_game record, if it has not had one: "won" if anyone had finished, otherwise "abandoned". */
  private recordGameEnd(g: Game, m: Meta): void {
    if (g.phase === "over" || m.ended) return;
    m.ended = true;
    const won = (g.finished ?? []).length > 0;
    this.rec({
      op: "ludo_game",
      outcome: won ? "ok" : "degraded",
      status: 200,
      ms: Date.now() - (m.startedAt ?? m.createdAt),
      detail: detail({
        mode: m.mode,
        result: won ? "won" : "abandoned",
        humans: g.seats.filter((k) => k === "human").length,
        winner: won ? (g.seats[g.finished![0]!] ?? "unknown") : "none",
        actions: g.log.length,
      }),
    });
  }

  /**
   * Everyone has left a game in play: record it once and close the room for good. What stays is one small record
   * saying it ended (names, chat, seat keys and the board are dropped), so the link can say so. The old move rows are
   * left where they are: deleting them would cost a row written each, the budget this is meant to save.
   */
  private async closeGame(reason: "left" | "idle"): Promise<void> {
    const g = this.game;
    const m = this.meta;
    if (!g || !m) return;
    this.recordGameEnd(g, m);
    this.endBotRun();
    this.game = null;
    this.meta = { mode: m.mode, keys: [null, null, null, null], createdAt: m.createdAt, startedAt: m.startedAt, turnStartedAt: m.turnStartedAt, due: null, ended: true, closed: { at: Date.now(), reason } };
    await this.ctx.storage.deleteAlarm();
    // One row: sending the telemetry already stores the (now closed) state; otherwise store it here.
    const sends = this.tq.length > 0 && !!this.env.LEDGER;
    this.flush();
    if (!sends) await this.persistState();
  }

  /**
   * Tell the room a person has taken over a bot's seat, once, as a line in the room chat (the room's own words, so
   * it stays in the room like any chat, never in telemetry). Waits for the newcomer's name, which their page sends
   * right after connecting; their colour stands in if there is none.
   */
  private announceTakeover(seat: number): void {
    const m = this.meta;
    if (!m?.takeover?.includes(seat)) return;
    m.takeover = m.takeover.filter((s) => s !== seat);
    const colour = COLOUR[seat]!;
    const who = m.names?.[seat];
    this.say(who ? `${who} joined and took over ${colour} from the bot` : `A new player joined and took over ${colour} from the bot`);
  }

  /** A line the room itself writes into the chat (friends' rooms only): kept in the room, never in telemetry. */
  private say(text: string, leaving?: WebSocket): void {
    const m = this.meta;
    if (!m || m.mode !== "code") return;
    const seq = (m.chatSeq ?? 0) + 1;
    const line: ChatLine = { id: seq, seat: -1, name: "", text, at: Date.now(), system: true };
    m.chatSeq = seq;
    m.chat = [...(m.chat ?? []), line].slice(-CHAT_KEEP);
    for (const s of this.ctx.getWebSockets()) if (s !== leaving) this.send(s, { t: "chat", lines: [line] });
  }

  /** Seats whose player has been away longer than AWAY_RELEASE_MS go back to the bot: name and seat key cleared. */
  private releaseAwaySeats(now: number): void {
    const g = this.game!;
    const m = this.meta!;
    m.awaySince?.forEach((since, seat) => {
      if (!since || now - since < AWAY_RELEASE_MS || !this.isAway(seat)) return;
      const who = this.seatName(seat);
      m.awaySince![seat] = null;
      g.seats[seat] = "bot";
      m.keys[seat] = null;
      if (m.names) m.names[seat] = null;
      this.say(`${who} didn't come back; ${COLOUR[seat]} is a bot again`);
    });
  }

  private seatName(seat: number): string {
    return this.meta?.names?.[seat] || COLOUR[seat]!;
  }

  /**
   * Bot steps are summarised, not recorded one by one: a solo game is about three bot steps to every human one, so
   * per-step events drowned the human signal in ludo_action and cost a log line each (3 Oct 2026). One event per run
   * of bot turns keeps the pacing signal: `ms` is the worst step's lateness, and the run is good only if every step
   * was within BOT_LAG_GOOD_MS.
   */
  private endBotRun(): void {
    const m = this.meta!;
    const run = m.botRun;
    m.botRun = undefined;
    if (!run || run.steps === 0) return;
    this.rec({
      op: "ludo_bot",
      outcome: run.late === 0 ? "ok" : "degraded",
      status: 200,
      ms: run.worst,
      detail: detail({ mode: m.mode, steps: run.steps, late: run.late }),
      fault: activeFault(this.env),
    });
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try {
      await this.handleClose(ws);
    } catch (e) {
      if (!isCapacity(e)) throw e;
    }
  }

  private async handleClose(ws: WebSocket): Promise<void> {
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    await this.load();
    const g = this.game;
    const m = this.meta;
    if (!g || !m) return;
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length > 0) {
      const { seat } = ws.deserializeAttachment() as Attachment;
      const playing = g.phase === "roll" || g.phase === "move";
      if (playing && !(g.finished ?? []).includes(seat) && this.isAway(seat, ws) && !m.awaySince?.[seat]) {
        (m.awaySince ??= [null, null, null, null])[seat] = Date.now();
        this.say(`${this.seatName(seat)} left; a bot is playing for them. Back within 2 minutes and the seat is still theirs`, ws);
        await this.schedule(ws);
        await this.persistState();
        this.broadcast();
      }
      return;
    }
    if (g.phase === "roll" || g.phase === "move") {
      // Mid-game and nobody left connected: hold the game for EMPTY_GRACE_MS, then end it (the alarm does).
      m.emptySince = Date.now();
      m.due = null;
      await this.ctx.storage.setAlarm(m.emptySince + EMPTY_GRACE_MS);
      await this.persistState();
      return;
    }
    if (g.phase === "lobby" && m.mode === "code") {
      this.rec({ op: "ludo_lobby", outcome: "degraded", status: 200, ms: Date.now() - m.createdAt, detail: detail({ result: "abandoned", humans: g.seats.filter((k) => k === "human").length, bots: 0 }) });
    }
    this.endBotRun(); // the room stops: an unfinished run of bot turns still counts
    m.due = null;
    m.names = [null, null, null, null]; // names and chat live only while someone is in the room
    m.chat = [];
    this.flush();
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
      finished: g.finished ?? [],
      earned: g.earned ?? null,
      names: m.names ?? [null, null, null, null],
      rolls: g.rolls ?? [[], [], [], []],
      lastRoller: lastRoller(g),
      moves: g.log.length,
      mode: m.mode,
      turnEndsAt: g.seats[g.turn] === "human" && g.phase !== "over" && g.phase !== "lobby" ? (m.promptAt ?? m.turnStartedAt) + HUMAN_PROMPT_MS : null,
      away: (m.awaySince ?? []).map((t, s) => (t ? s : -1)).filter((s) => s >= 0),
    };
    for (const ws of this.ctx.getWebSockets()) {
      const { seat } = ws.deserializeAttachment() as Attachment;
      this.send(ws, { t: "state", you: seat, g: view });
    }
  }
}
