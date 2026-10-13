// Discourse: a private two-person chat at /discourse/ (unlisted on purpose). One Durable Object holds everything:
// the two profiles' passcode hashes, their sessions, the messages, and the live sockets.
//
// Removing the feature: delete worker/discourse/, src/pages/discourse.astro, the DISCOURSE* lines in worker/env.ts,
// the route line in worker/index.ts, and the DISCOURSE binding + "v4" migration in wrangler.jsonc.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

export type Role = "girl" | "boy";
const ROLES: Role[] = ["girl", "boy"];
/** The only admin: may delete any message. */
const ADMIN: Role = "boy";

const KEEP = 500;
const MAX_TEXT = 1000;
const MAX_FRAME = 4096;
const SESSION_MS = 30 * 24 * 3600_000;
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60_000;
const MIN_GAP_MS = 400;
const enc = new TextEncoder();

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function same(a: Uint8Array, b: Uint8Array): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

async function derive(code: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-robots-tag": "noindex", ...headers } });

type Msg = { id: number; role: Role; text: string; at: number };

export class DiscourseRoom extends DurableObject<Env> {
  private lastSent = new Map<Role, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS creds (role TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS sessions (role TEXT PRIMARY KEY, hash TEXT NOT NULL, exp INTEGER NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  // ── passcodes ──
  /** A stored (changed) passcode wins; until one is changed, the deploy-time secret is the passcode. No secret, no entry. */
  private async check(role: Role, code: string): Promise<boolean> {
    const row = this.ctx.storage.sql.exec<{ salt: string; hash: string }>("SELECT salt, hash FROM creds WHERE role = ?", role).toArray()[0];
    if (row) return same(await derive(code, unhex(row.salt)), unhex(row.hash));
    const seed = role === "girl" ? this.env.DISCOURSE_GIRL_CODE : this.env.DISCOURSE_BOY_CODE;
    if (!seed) return false;
    return same(await sha256(code), await sha256(seed));
  }

  private async setCode(role: Role, code: string): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO creds (role, salt, hash) VALUES (?, ?, ?)", role, hex(salt), hex(await derive(code, salt)));
  }

  // ── lockout: wrong passcodes in a row lock sign-in for everyone for a while (no IP is stored, so it is global) ──
  private locked(): boolean {
    return (this.ctx.storage.kv.get<number>("until") ?? 0) > Date.now();
  }
  private failed(): void {
    const n = (this.ctx.storage.kv.get<number>("fails") ?? 0) + 1;
    if (n >= MAX_FAILS) { this.ctx.storage.kv.put("until", Date.now() + LOCK_MS); this.ctx.storage.kv.put("fails", 0); }
    else this.ctx.storage.kv.put("fails", n);
  }
  private cleared(): void {
    if (this.ctx.storage.kv.get<number>("fails")) this.ctx.storage.kv.put("fails", 0);
  }

  // ── sessions: one per profile, so there can never be more than two people in ──
  private async who(request: Request): Promise<Role | null> {
    const token = /(?:^|;\s*)discourse=([a-f0-9]{64})/.exec(request.headers.get("cookie") ?? "")?.[1];
    if (!token) return null;
    const h = hex(await sha256(token));
    const row = this.ctx.storage.sql.exec<{ role: Role }>("SELECT role FROM sessions WHERE hash = ? AND exp > ?", h, Date.now()).toArray()[0];
    return row?.role ?? null;
  }

  private cookie(request: Request, token: string, maxAge: number): string {
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return `discourse=${token}; Path=/discourse/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
  }

  private kick(role: Role): void {
    for (const ws of this.ctx.getWebSockets(role)) { try { ws.close(4001, "signed out"); } catch { /* already closed */ } }
  }

  private online(except?: WebSocket): Role[] {
    const live = this.ctx.getWebSockets().filter((w) => w !== except && w.readyState === WebSocket.OPEN);
    return ROLES.filter((r) => live.some((w) => this.ctx.getTags(w).includes(r)));
  }

  private broadcast(frame: unknown, except?: WebSocket): void {
    const s = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(s); } catch { /* closing */ }
    }
  }

  private history(): Msg[] {
    return this.ctx.storage.sql.exec<Msg>("SELECT id, role, text, at FROM msgs ORDER BY id DESC LIMIT ?", KEEP).toArray().reverse();
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/^\/discourse\/api/, "");

    if (path === "/login" && request.method === "POST") {
      if (this.locked()) return json({ error: "locked" }, 429);
      const body = await this.body<{ passcode?: unknown }>(request);
      const code = typeof body?.passcode === "string" && body.passcode.length <= 128 ? body.passcode : "";
      let role: Role | null = null;
      if (code) for (const r of ROLES) if (await this.check(r, code)) role = r;
      if (!role) { this.failed(); return json({ error: "wrong" }, 401); }
      this.cleared();
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO sessions (role, hash, exp) VALUES (?, ?, ?)", role, hex(await sha256(token)), Date.now() + SESSION_MS);
      this.kick(role);
      return json({ role }, 200, { "set-cookie": this.cookie(request, token, SESSION_MS / 1000) });
    }

    const me = await this.who(request);
    if (!me) return json({ error: "signin" }, 401);

    if (path === "/me" && request.method === "GET") return json({ role: me, admin: me === ADMIN });

    if (path === "/logout" && request.method === "POST") {
      this.ctx.storage.sql.exec("DELETE FROM sessions WHERE role = ?", me);
      this.kick(me);
      return json({ ok: true }, 200, { "set-cookie": this.cookie(request, "", 0) });
    }

    if (path === "/passcode" && request.method === "POST") {
      if (this.locked()) return json({ error: "locked" }, 429);
      const body = await this.body<{ current?: unknown; next?: unknown }>(request);
      const current = typeof body?.current === "string" ? body.current.slice(0, 128) : "";
      const next = typeof body?.next === "string" ? body.next : "";
      if (!(await this.check(me, current))) { this.failed(); return json({ error: "wrong" }, 401); }
      if (next.length < 6 || next.length > 64) return json({ error: "length" }, 400);
      // Passcodes pick the profile at sign-in, so they must never collide.
      if (await this.check(me === "girl" ? "boy" : "girl", next)) return json({ error: "taken" }, 400);
      this.cleared();
      await this.setCode(me, next);
      return json({ ok: true });
    }

    if (path === "/ws" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server, [me]);
      server.send(JSON.stringify({ t: "hello", me, admin: me === ADMIN, msgs: this.history(), online: this.online() }));
      this.broadcast({ t: "presence", online: this.online() }, server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return json({ error: "not_found" }, 404);
  }

  private async body<T>(request: Request): Promise<T | null> {
    try {
      const text = await request.text();
      return text.length <= MAX_FRAME ? (JSON.parse(text) as T) : null;
    } catch {
      return null;
    }
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const role = this.ctx.getTags(ws)[0] as Role | undefined;
    if (!role || typeof data !== "string" || data.length > MAX_FRAME) return;
    let m: { t?: unknown; text?: unknown; id?: unknown };
    try { m = JSON.parse(data); } catch { return; }
    const sql = this.ctx.storage.sql;

    if (m.t === "send" && typeof m.text === "string") {
      const text = m.text.trim();
      const now = Date.now();
      if (!text || text.length > MAX_TEXT || now - (this.lastSent.get(role) ?? 0) < MIN_GAP_MS) return;
      this.lastSent.set(role, now);
      const id = sql.exec<{ id: number }>("INSERT INTO msgs (role, text, at) VALUES (?, ?, ?) RETURNING id", role, text, now).one().id;
      sql.exec("DELETE FROM msgs WHERE id NOT IN (SELECT id FROM msgs ORDER BY id DESC LIMIT ?)", KEEP);
      this.broadcast({ t: "msg", m: { id, role, text, at: now } });
    } else if (m.t === "del" && role === ADMIN && typeof m.id === "number" && Number.isInteger(m.id)) {
      sql.exec("DELETE FROM msgs WHERE id = ?", m.id);
      this.broadcast({ t: "del", id: m.id });
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    try { ws.close(); } catch { /* already closed */ }
    this.broadcast({ t: "presence", online: this.online(ws) }, ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }
}
