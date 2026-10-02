// Ludo rules as pure functions over plain data: no clock, no I/O, no Math.random.
// Dice and bot choices come from a seeded PRNG kept in the state, so a game replays exactly
// from its seed plus the ordered list of actions (`log`).

export const SEATS = 4;
export const TOKENS = 4;
/** Dice kept per seat for the on-screen history. */
export const ROLL_HISTORY = 10;
/** Progress: -1 in the yard, 0–50 on the shared track, 51–55 in the home column, 56 home. */
export const HOME = 56;
const TRACK = 52;
/** Where each seat enters the track (absolute square). */
export const START = [0, 13, 26, 39] as const;
/** Start squares and star squares: no captures here. */
const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export type SeatKind = "human" | "bot" | "empty";
export type Phase = "lobby" | "roll" | "move" | "over";
/** `auto`: the server chose this move (bot or timed-out human), which consumed one RNG draw. */
export type Action = { seat: number; kind: "roll" } | { seat: number; kind: "move"; token: number; auto?: true };

export interface Game {
  seed: number;
  rng: number;
  seats: SeatKind[];
  tokens: number[][];
  turn: number;
  phase: Phase;
  die: number | null;
  /** Token indexes the current seat may move with `die`. */
  legal: number[];
  winner: number | null;
  /** Each seat's last ten dice, oldest first. Optional only so games saved before it existed still load. */
  rolls?: number[][];
  /** Every applied action, in order: the replay record. */
  log: Action[];
}

/** mulberry32: small, fast, deterministic. Returns [value in [0,1), next state]. */
function next(rng: number): [number, number] {
  const s = (rng + 0x6d2b79f5) | 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

export function newGame(seed: number, seats: SeatKind[]): Game {
  return {
    seed,
    rng: seed | 0,
    seats: [...seats],
    tokens: Array.from({ length: SEATS }, () => Array<number>(TOKENS).fill(-1)),
    turn: 0,
    phase: "lobby",
    die: null,
    legal: [],
    winner: null,
    rolls: Array.from({ length: SEATS }, () => []),
    log: [],
  };
}

export function start(g: Game): Game {
  const first = g.seats.findIndex((k) => k !== "empty");
  return { ...g, phase: "roll", turn: first < 0 ? 0 : first };
}

export const absolute = (seat: number, progress: number): number => ((START[seat] ?? 0) + progress) % TRACK;

export function legalMoves(tokens: readonly number[], die: number): number[] {
  const out: number[] = [];
  tokens.forEach((p, i) => {
    if (p === -1 ? die === 6 : p < HOME && p + die <= HOME) out.push(i);
  });
  return out;
}

function nextSeat(g: Game, from: number): number {
  for (let k = 1; k <= SEATS; k++) {
    const s = (from + k) % SEATS;
    if (g.seats[s] !== "empty") return s;
  }
  return from;
}

/** Apply one action. Throws on an illegal action; callers turn that into an "invalid" reply. */
export function apply(g: Game, a: Action): Game {
  if (g.phase === "over" || g.phase === "lobby") throw new Error("not_playing");
  if (a.seat !== g.turn) throw new Error("not_your_turn");

  if (a.kind === "roll") {
    if (g.phase !== "roll") throw new Error("not_roll_phase");
    const [r, rng] = next(g.rng);
    const die = 1 + Math.floor(r * 6);
    const legal = legalMoves(g.tokens[a.seat] ?? [], die);
    const log = [...g.log, a];
    const rolls = Array.from({ length: SEATS }, (_, s) => {
      const mine = g.rolls?.[s] ?? [];
      return s === a.seat ? [...mine, die].slice(-ROLL_HISTORY) : mine;
    });
    if (legal.length === 0) return { ...g, rng, die, legal: [], rolls, phase: "roll", turn: nextSeat(g, a.seat), log };
    return { ...g, rng, die, legal, rolls, phase: "move", log };
  }

  if (g.phase !== "move" || g.die === null) throw new Error("not_move_phase");
  if (!g.legal.includes(a.token)) throw new Error("illegal_token");
  const die = g.die;
  const tokens = g.tokens.map((t) => [...t]);
  const mine = tokens[a.seat]!;
  const from = mine[a.token]!;
  const to = from === -1 ? 0 : from + die;
  mine[a.token] = to;

  let captured = false;
  if (to <= 50) {
    const sq = absolute(a.seat, to);
    if (!SAFE.has(sq)) {
      tokens.forEach((theirs, s) => {
        if (s === a.seat) return;
        theirs.forEach((p, i) => {
          if (p >= 0 && p <= 50 && absolute(s, p) === sq) {
            theirs[i] = -1;
            captured = true;
          }
        });
      });
    }
  }

  const log = [...g.log, a];
  if (mine.every((p) => p === HOME)) {
    return { ...g, tokens, die: null, legal: [], phase: "over", winner: a.seat, log };
  }
  const again = die === 6 || captured || to === HOME;
  return { ...g, tokens, die: null, legal: [], phase: "roll", turn: again ? a.seat : nextSeat(g, a.seat), log };
}

/** The server's move for a bot or a timed-out human: a seeded random legal action. */
export function autoAction(g: Game): [Action, Game] {
  if (g.phase === "roll") return [{ seat: g.turn, kind: "roll" }, g];
  const [r, rng] = next(g.rng);
  const token = g.legal[Math.floor(r * g.legal.length)] ?? g.legal[0]!;
  return [{ seat: g.turn, kind: "move", token, auto: true }, { ...g, rng }];
}

/** Rebuild a game from its seed, seats and action log: the determinism check. */
export function replay(seed: number, seats: SeatKind[], log: Action[]): Game {
  let g = start(newGame(seed, seats));
  for (const a of log) {
    if (a.kind === "move" && a.auto) g = { ...g, rng: next(g.rng)[1] };
    g = apply(g, a);
  }
  return g;
}
