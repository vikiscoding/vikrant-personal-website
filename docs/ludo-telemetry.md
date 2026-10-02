# Ludo: interaction-latency testbed

`/ludo/` is a server-authoritative Ludo game. It exists to measure how long a real interaction takes, end to end, on a path this site owns. Proposed in ADR-026; it conflicts with ADR-015's "no game two" stop rule until that ADR is accepted.

## How it runs

| Part | File | Notes |
| --- | --- | --- |
| Rules | `worker/ludo/engine.ts` | Pure functions. Dice and bot choices come from a seeded PRNG (mulberry32) kept in the state. A game replays exactly from `seed` + `log`; moves the server chose are flagged `auto`. Checked: 2,000 seeded bot games all finish and replay identically. |
| Room | `worker/ludo/room.ts` | One SQLite-backed Durable Object per room, WebSockets with hibernation, one alarm for bot steps and turn timeouts. |
| Route | `worker/ludo/route.ts` | `GET /api/ludo?room=…&key=…` WebSocket upgrade. Same origin only; room `s-<16 hex>` (solo) or `c-<4–6 A–Z0–9>` (code); key = random 16-hex seat token per tab. |
| Page | `src/pages/ludo.astro` | Canvas board, roll button, click a highlighted token. Shows the player's own action time and round trip (computed in the browser, never sent). |

**Solo:** you plus three server bots; starts at once. **Code:** seats fill in join order; the game starts when four have joined, or when a seated player presses *Start now with bots*. A fifth connection is refused (409). A player who leaves can rejoin the same seat from the same tab.

**Abuse limits:** 256-byte messages, five message types with strict shapes, 40 messages per 10 s per socket (then close 1008), 8 sockets per room. Rejected actions get an error reply and are logged, never counted as server failures.

## Patience budgets

From response-time research (0.1 s feels instant, 1 s keeps flow, 10 s loses attention) and turn-based play:

| Interaction | Good | Hurts | Why |
| --- | --- | --- | --- |
| Your action → board updates | ≤ 100 ms server time | > 1 s | A roll must feel like a die, not a request |
| Round trip (server-timed) | ≤ 300 ms | > 1 s | Above this, every move feels sticky |
| Bot step lateness | ≤ 250 ms past its 700 ms pace | > 1 s | Bots set the rhythm of a solo game |
| Connect | answered | error | You cannot play at all |
| Lobby wait (code rooms) | ≤ 2 min | abandoned | Friends give up waiting |
| Human turn | — | 30 s, then the server plays for you | Keeps three other people from waiting on one |

## Event schema

Every Ludo event is an ordinary SLI event (`docs/log-schema.md`): `v, ts, op, outcome, status, ms, detail, fault`. It goes to Workers Logs and to the SLI ledger (daily counts and a latency histogram per `op`; every non-good or slow event in full, capped at 500 per source per day). `detail` is space-separated `key=value` pairs, with a fixed key set per op, enforced at compile time by `worker/ludo/telemetry.ts`. Values are enums or integers: never names, IPs or seat keys.

| op (ledger source) | Emitted | `ms` means | `outcome` ok when | `detail` keys | Proposed target |
| --- | --- | --- | --- | --- | --- |
| `ludo_connect` | each WebSocket upgrade, in the site Worker | time to the room's answer | 101, or a correct 4xx (full, busy) | `mode` solo/code · `result` open/full/busy/rejected/error · `reason`? | 99.5% |
| `ludo_action` | each human action; each bot step | human: receive → saved → broadcast · bot: alarm lateness + work | human ≤ 100 ms · bot ≤ 250 ms | `mode` · `actor` human/bot · `kind` roll/move/start · `lag`? (bot) | 99% |
| `ludo_rtt` | server probe every 15 s, echoed at once by the page | server-timed round trip | ≤ 300 ms | `mode` | 95% |
| `ludo_turn` | each human action on their turn; each 30 s timeout | think time: prompt pushed → action received | the human acted (a timeout is "degraded") | `mode` · `result` acted/timeout · `kind` | tracked |
| `ludo_lobby` | code room start, or the last player leaving the lobby | wait since the room was created | started within 2 min | `result` started/abandoned · `humans` · `bots` | tracked |
| `ludo_game` | a winner, or the last player leaving mid-game | game duration | a winner | `mode` · `result` won/abandoned · `humans` · `winner` human/bot/none · `actions` | tracked |

Logged only, not in the ledger: `ludo_invalid` (a rejected action: the player's mistake or a stale screen, never a server failure).

**Where it shows:** `/reliability/#ludo` (Server path card: the three proposed objectives with worst-day p95, games finished, lobbies started, turns timed out and today's median think time) and `/api/slo?days=N` (`summary` and `days` rows for every `ludo_*` source). Ludo events are kept off the site's Failures list.

**Game day:** deploy `FAULT=ludo_slow` (adds 400 ms to every human action) and watch `ludo_action` burn its budget; restore with `FAULT=none`.

## What the player sees

The die is a button (or press Space): it tumbles from the click until the server's number arrives (at least 350 ms, so it reads as a throw), then shows that face and keeps it until the next throw. Every roll anywhere tumbles the die in the roller's colour. Tickers show your last 10 rolls and each opponent's last 5; the history lives in the engine state, so every screen agrees and replays include it. Tokens sharing a square stack (same colour, with a count badge) or sit side by side (different colours).

## Telemetry not built yet

- Client-perceived action time (send → board drawn) beaconed back. It is shown to the player now; sending it would be a second spoofable client signal, like Pulse run's.
- Reconnect count and time-to-rejoin per seat.
- Storage: the action log is rewritten on every step (≈ 50 KB by game end). Fine at this scale; move to append-only SQL rows if rooms get busy.
