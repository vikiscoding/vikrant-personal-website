# Ludo: interaction-latency testbed

`/ludo/` is a server-authoritative Ludo game. It exists to measure how long a real interaction takes, end to end, on a path this site owns. Accepted in ADR-026 (2 Oct 2026), which supersedes ADR-015's "no game two" stop rule; the stop rule is now "no third game".

## How it runs

| Part | File | Notes |
| --- | --- | --- |
| Rules | `worker/ludo/engine.ts` | Pure functions. Dice and bot choices come from a seeded PRNG (mulberry32) kept in the state. A game replays exactly from `seed` + `log`; moves the server chose are flagged `auto`. Checked: 2,000 seeded bot games all finish and replay identically. |
| Room | `worker/ludo/room.ts` | One SQLite-backed Durable Object per room, WebSockets with hibernation, one alarm for bot steps and turn timeouts. |
| Route | `worker/ludo/route.ts` | `GET /api/ludo?room=…&key=…` WebSocket upgrade. Same origin only; room `s-<16 hex>` (solo) or `c-<4–6 A–Z0–9>` (code); key = random 16-hex seat token per tab. |
| Page | `src/pages/ludo.astro` | Canvas board, roll button, click a highlighted token. Shows the player's own action time and round trip (computed in the browser, never sent). |

**Solo:** you plus three server bots; starts at once. **Idle players:** while a player's tab stays connected, each prompt waits 15 s; then the server rolls for them, or plays the best legal move (`bestMove` in the engine: finish a token, capture, leave the yard, reach the home column or a safe square, escape danger, then progress). It uses no randomness, so replays stay exact; in 1,000 simulated games it won 82% against random bots. Bots keep playing seeded random moves. **Names:** optional, 1–16 letters, digits, spaces and `- _ . '`, checked on the server, shown to the room, kept only in the room's state and cleared when the last player leaves; never in telemetry. **Code:** seats fill in join order; the game starts when four have joined, or when a seated player presses *Start now with bots*. A fifth connection is refused (409). A player who leaves can rejoin the same seat from the same tab.

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
| Each prompt to a human (roll, then move) | acted | 15 s, then the server acts for them | Keeps three other people from waiting on one |

## Event schema

Every Ludo event is an ordinary SLI event (`docs/log-schema.md`): `v, ts, op, outcome, status, ms, detail, fault`. It goes to Workers Logs and to the SLI ledger (daily counts and a latency histogram per `op`; every non-good or slow event in full, capped at 500 per source per day). `detail` is space-separated `key=value` pairs, with a fixed key set per op, enforced at compile time by `worker/ludo/telemetry.ts`. Values are enums or integers: never names, IPs or seat keys.

| op (ledger source) | Emitted | `ms` means | `outcome` ok when | `detail` keys | Proposed target |
| --- | --- | --- | --- | --- | --- |
| `ludo_connect` | each WebSocket upgrade, in the site Worker | time to the room's answer | 101, or a correct 4xx (full, busy) | `mode` solo/code · `result` open/full/busy/rejected/error · `reason`? | 99.5% |
| `ludo_action` | each human action; each bot step | human: receive → saved → broadcast · bot: alarm lateness + work | human ≤ 100 ms · bot ≤ 250 ms | `mode` · `actor` human/bot · `kind` roll/move/start · `lag`? (bot) | 99% |
| `ludo_rtt` | server probe every 15 s, echoed at once by the page | server-timed round trip | ≤ 300 ms | `mode` | 95% |
| `ludo_turn` | each human action on their turn; each 15 s prompt timeout | think time: prompt pushed → action received | the human acted (a timeout is "degraded") | `mode` · `result` acted/timeout · `kind` | tracked |
| `ludo_lobby` | code room start, or the last player leaving the lobby | wait since the room was created | started within 2 min | `result` started/abandoned · `humans` · `bots` | tracked |
| `ludo_game` | a winner, or the last player leaving mid-game | game duration | a winner | `mode` · `result` won/abandoned · `humans` · `winner` human/bot/none · `actions` | tracked |

Logged only, not in the ledger: `ludo_invalid` (a rejected action: the player's mistake or a stale screen, never a server failure).

**Where it shows:** `/reliability/#ludo` (Server path card: the three proposed objectives with worst-day p95, games finished, lobbies started, turns timed out and today's median think time) and `/api/slo?days=N` (`summary` and `days` rows for every `ludo_*` source). Ludo events are kept off the site's Failures list.

**Game day:** deploy `FAULT=ludo_slow` (adds 400 ms to every human action) and watch `ludo_action` burn its budget; restore with `FAULT=none`.

## What the player sees

UX review, 2 Oct 2026 (panel: game UX designer, mobile and accessibility specialist, front-end performance engineer, SRE, privacy reviewer). Agreed and built:

| Area | Decision |
| --- | --- |
| Flow | An app window with three screens: **start** (optional name, *Play vs 3 bots*, *Play with friends*, join by code), **lobby** (four seats filling live, invite link with Copy or the phone's share sheet, *Start now, bots fill empty seats*) and **game**. Invite links (`/ludo/?code=ABCD`) open on "Join game ABCD". Game over shows the winner with **Rematch** (same room, seats and names, new seed; refused while a game is running) and **New solo game**. |
| Fewer taps | The server moves for a human when every legal token is on the same square (the choice cannot matter), in addition to the single-legal-move case. |
| Reading the board | Each player's board is turned so their base is bottom-left, outlined and marked YOU; yard labels sit on each yard's top and bottom edge as seen on that screen. Same-colour stacks show a count badge; different colours share a square side by side. Dashed rings show where each movable token would land. |
| Motion | Tokens hop square by square (at most about 0.65 s per move); captured tokens slide back to their yard after the mover lands. Only real single steps animate or raise a toast, never a join, rejoin or rematch. `prefers-reduced-motion` turns animation off. |
| Feedback | The die tumbles until the server's number arrives (at least 350 ms) and keeps the last face; a countdown ring around it shows the 15 s prompt; the die pulses when it is your turn and the phone vibrates briefly. Toasts over the board centre announce captures and tokens reaching home (also read out by screen readers). Rolls tickers: your last 10, each opponent's last 5. |
| Phones | **Full screen** button in the window's title bar: the Fullscreen API where available, otherwise (iPhone Safari) a fixed full-viewport overlay with safe-area padding and page scroll locked. Back, Esc or the Exit button leave it. Portrait puts the board on top at full width with controls below; landscape puts them side by side with the panel scrolling on its own. Tap targets are at least 44 px; the board ignores double-tap zoom. |
| Keyboard | Space or Enter rolls; 1–4 moves that token. |
| Room chat | Code rooms only (solo has nobody to read it). One chat element, placed inline in the lobby, in the side panel on wide screens, and in a slide-up sheet (💬 button with an unread badge, preview toast) on phones and in full screen. Bubbles: yours on the right in your colour, others on the left with name and colour dot. Quick replies: 👍 😂 😮 🎲 gg nice!. A player who rejoins gets the history. |
| Two players and bots | The lobby button says exactly what happens ("Start now with 2 bots"); bots take the empty seats and play seeded random moves. |
| Privacy and telemetry | No new telemetry; full-screen use is not tracked. |

Verified on the dev Worker: phone (390 × 844) and desktop renders of every screen, portrait and landscape full screen; a lobby, *Start now* and the rematch guard over live WebSockets; a full four-player game (583 moves) followed by a rematch.

## Text people type: any language

Names and chat are checked on the server by pure functions in `worker/ludo/text.ts` (unit-testable outside Workers):

- **Kept:** every script's letters with their combining marks, digits, the zero-width non-joiner and joiner (Persian and Indic scripts, joined emoji), direction marks, emoji with skin tones and flags.
- **Removed:** control characters, and the bidi embedding and override characters (U+202A–202E, U+2066–2069) that can visually reorder text to spoof it.
- **Limits** count what a reader sees (grapheme clusters via `Intl.Segmenter`): names 1–16, chat 1–200, plus a size cap.
- **Display:** escaped, with `dir="auto"`, so right-to-left text reads correctly inside a left-to-right page.
- **Chat limits:** 5 messages per 10 s per player, at least 0.6 s apart; the room keeps the last 30.
- **Privacy:** names and chat live only in the room's storage, are cleared when the last player leaves, and never go into telemetry or logs.

Verified: 18 sample messages (Hindi, Tamil, Bengali, Punjabi, Arabic, Hebrew, Persian, Chinese, Japanese, Korean, Thai, Russian, Greek, Vietnamese, Amharic, joined emoji, flags and skin tones, mixed direction) pass unchanged; names in Devanagari, Arabic, Chinese, Thai and Persian are accepted; overrides, control characters, markup and over-long input are rejected or stripped. Live on the dev Worker: two players chatted in four scripts, the rate limit held, they started with two bots, and a rejoining player got the history.

## Scale

Each room is its own Durable Object and shares nothing with other rooms, so rooms scale out side by side. Two shared costs were removed on 2 Oct 2026 (ADR-027):

| Change | Before | After |
| --- | --- | --- |
| Telemetry to the shared SLI ledger | One ledger call per event (about two per move) | One call per room batch (25 events or 20 s, and at game end or when the room empties); the ledger merges a batch into one upsert per signal per day (`SliLedger.addBatch`) |
| Move log | The whole log rewritten on every move (up to about 50 KB) | Appended as one small row per move (`log:000123`); the game record is stored without it |

Batches wait in the room's own storage until sent, so a room paused between moves loses nothing; a failed send is retried with the next batch. Workers Logs still get every event as it happens.

Load test on the dev Worker (40 four-player rooms, 160 sockets, 60 s, scripted players acting as fast as the game allows):

| | Before | After |
| --- | --- | --- |
| Actions per second | 194 | 198 |
| p50 / p95 | 49 / 64 ms | 48 / 60 ms |
| p99 / max | 240 / 485 ms | 80 / 304 ms |
| Errors | 0 | 0 |
| Every action in the ledger | yes | yes |

Not tested on purpose: the load at which a single room or the ledger saturates. The account is on Cloudflare's Free plan, whose daily Durable Object limit is shared with production, so a test of a few hundred rooms could take the live site's ledger, counter and Ludo down until the daily reset. Run it only on a paid plan, as a game day. Every deploy restarts Durable Objects and drops live sockets; the page reconnects and the game resumes from storage.

## Game rules worth knowing

- **Play continues for every place.** A player who brings all four tokens home is recorded 1st, 2nd and so on; finished seats are skipped, and the game ends when one player is left (last place). Each finisher can keep watching or leave; game over shows the full placings.
- **Leave at any time.** In a friends' room a bot takes a playing seat at once, so the others play on (a lobby seat is simply freed, and the old seat key cannot come back). When the last person leaves, or in a solo game, the room stops: no alarm and no bots playing to an empty room. Telemetry counts a game as completed if anyone finished before everyone left.

## Telemetry not built yet

- Client-perceived action time (send → board drawn) beaconed back. It is shown to the player now; sending it would be a second spoofable client signal, like Pulse run's.
- Reconnect count and time-to-rejoin per seat.
