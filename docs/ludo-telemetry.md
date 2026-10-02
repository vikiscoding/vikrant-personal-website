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

## SLIs (all server-measured, in the SLI ledger)

| Ledger source | Event | Good when | Proposed target |
| --- | --- | --- | --- |
| `ludo_connect` | each upgrade attempt | room answered (101 or a correct 4xx) | 99.5% |
| `ludo_action` | each human action; each bot step | human: receive → saved → broadcast ≤ 100 ms; bot: lateness + work ≤ 250 ms | 99% |
| `ludo_rtt` | server probe every 15 s, echoed at once | ≤ 300 ms | 95% |
| `ludo_lobby` | code room start or abandonment | started within 2 min | tracked |
| `ludo_game` | game end | a winner (vs abandoned) | tracked |

Logged only: `ludo_invalid` (rejected action), `ludo_timeout` (a human's turn auto-played). Read everything at `/api/slo?days=N`; Ludo events are kept off the site's Failures list.

**Game day:** deploy `FAULT=ludo_slow` (adds 400 ms to every human action) and watch `ludo_action` burn its budget; restore with `FAULT=none`.

## Telemetry not built yet

- Client-perceived action time (send → board drawn) beaconed back. It is shown to the player now; sending it would be a second spoofable client signal, like Pulse run's.
- Reconnect count and time-to-rejoin per seat.
- Turn think time distribution (engagement, not reliability).
- Dashboard cards on `/reliability/` for the three proposed SLOs.
- Storage: the action log is rewritten on every step (≈ 50 KB by game end). Fine at this scale; move to append-only SQL rows if rooms get busy.
