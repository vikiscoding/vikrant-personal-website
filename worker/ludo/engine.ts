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
  /** The first seat to bring every token home. Set at the first finish; the game goes on for the other places. */
  winner: number | null;
  /** Finishing order, 1st first. Play continues until one seat is left, which takes last place. Optional only so
   *  games saved before it existed still load. */
  finished?: number[];
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
    finished: [],
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

/** The next seat still playing: empty seats and seats that have finished are skipped. */
function nextSeat(g: Game, from: number): number {
  const done = g.finished ?? [];
  for (let k = 1; k <= SEATS; k++) {
    const s = (from + k) % SEATS;
    if (g.seats[s] !== "empty" && !done.includes(s)) return s;
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
    // This seat has finished: record its place, and keep playing for the others until only one is left.
    const finished = [...(g.finished ?? []), a.seat];
    const winner = finished[0] ?? a.seat;
    const left = g.seats.map((k, s) => (k !== "empty" && !finished.includes(s) ? s : -1)).filter((s) => s >= 0);
    if (left.length <= 1) {
      return { ...g, tokens, die: null, legal: [], phase: "over", winner, finished: [...finished, ...left], log };
    }
    const after = { ...g, finished };
    return { ...g, tokens, die: null, legal: [], phase: "roll", winner, finished, turn: nextSeat(after, a.seat), log };
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

/** How many opponent tokens could land on `square` with one die (1–6 squares behind it on the shared track). */
function threats(g: Game, seat: number, square: number): number {
  if (SAFE.has(square)) return 0;
  let n = 0;
  g.tokens.forEach((list, s) => {
    if (s === seat || g.seats[s] === "empty") return;
    for (const p of list) {
      if (p < 0 || p > 50) continue;
      const gap = (square - absolute(s, p) + TRACK) % TRACK;
      if (gap >= 1 && gap <= 6) n++;
    }
  });
  return n;
}

/** The move a sensible player makes for an idle human: no randomness, so replays stay exact.
 * Priority: finish a token, capture, leave the yard, reach the home column or a safe square, escape danger, then progress. */
export function bestMove(g: Game): number {
  if (g.phase !== "move" || g.die === null || g.legal.length === 0) throw new Error("not_move_phase");
  const seat = g.turn;
  const die = g.die;
  let best = g.legal[0]!;
  let bestScore = -Infinity;
  for (const i of g.legal) {
    const from = g.tokens[seat]![i]!;
    const to = from === -1 ? 0 : from + die;
    let score = to / 10; // progress as the tie-breaker
    if (to === HOME) score += 100;
    if (from === -1) score += 60;
    if (to <= 50) {
      const sq = absolute(seat, to);
      const captures = !SAFE.has(sq) && g.tokens.some((list, s) => s !== seat && list.some((p) => p >= 0 && p <= 50 && absolute(s, p) === sq));
      if (captures) score += 80;
      if (SAFE.has(sq)) score += 20;
      score -= 30 * threats(g, seat, sq);
    } else if (from <= 50) {
      score += 40; // into the home column: safe for good
    }
    if (from >= 0 && from <= 50) score += 25 * threats(g, seat, absolute(seat, from)); // escaping danger
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
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
