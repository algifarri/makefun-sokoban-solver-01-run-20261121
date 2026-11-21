// sokoban-solver-01-run-20261121 entry: a push-optimal Sokoban solver.
//
// Strategy, built for the generator's levels (one hallway, one to four rooms
// of 3-4 boxes each, every box staying in its room):
//   1. Split the level into rooms: cut the hallway row's dead squares (a box
//      there reaches no goal) and take each connected part holding boxes.
//   2. Solve each room on its own with A* over pushes. A state is the boxes'
//      squares plus the player's reachable region (named by its lowest square).
//      The estimate is the cheapest assignment of boxes to goals over
//      shortest-path distances that stay on live squares (admissible, so the
//      first solved state popped is push-optimal). Dead squares and frozen
//      2x2 blocks of walls/boxes are pruned: neither can be part of a solution.
//   3. Rooms are solved in scan order, the other rooms' boxes standing as
//      walls. Every room but the last must end with the player able to walk
//      back out to the hallway, so the next room stays reachable.
//   4. Fallbacks, in order: the same room-by-room search without the exit
//      requirement, then one A* over the whole level. If every search gives up,
//      the level gets an empty (valid, unscored) answer rather than none.
//   5. Everything is deterministic: fixed expansion caps measured in states,
//      never the wall clock, fixed direction order, fixed tie-breaks. Two runs
//      write the same bytes.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Work budgets only (never the clock): how many states one search may keep. */
const MAX_ROOM_STATES = 400_000;
const MAX_WHOLE_STATES = 600_000;

const DIRS: readonly (readonly [number, number, string, string])[] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface PushSol {
  pushes: number;
  moves: string;
  endPlayer: number;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/** A level in XSB text. Short rows and the outer frame read as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * The squares from which a box alone can still be pushed onto some goal:
 * pull back from the goals; a box on a square x can be pushed to x + d when
 * the player can stand at x - d, so x - d is live whenever x is.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DIRS[k][1] * w + DIRS[k][0];
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The lowest square of the region the player reaches from `from`. */
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the player, from `from`, can reach any floor square of `row`. */
function reachesRow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  row: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): boolean {
  const { w, wall } = level;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (Math.floor(p / w) === row) return true;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return false;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and
 * boxes holding a box off its goal: no push can ever move such a box again.
 */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b])) return true;
    if ((occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** The shortest walk from `from` to `to` around walls and boxes (lower LURD). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DIRS[k][1] * w + DIRS[k][0];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = DIRS[k][2];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** All orderings of 0..n-1 (n is at most 4 here, so at most 24). */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}

/**
 * The push-optimal solution of `level` (A* over pushes), or null when the
 * search gives up at `maxStates` states. When `needExit` is set, a solved
 * state only counts when the player can still reach the hallway row, so the
 * next room stays reachable; that costs nothing in pushes (an optimal
 * exit-leaving solution exists from any hallway-reachable start).
 */
function solvePushAStar(level: Level, maxStates: number, needExit: boolean, hallwayRow: number): PushSol | null {
  const { w, wall, goals, boxes: startBoxes, player: startPlayer } = level;
  const size = wall.length;
  const n = startBoxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (startBoxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);

  // Shortest-path distances from each goal, travelling on live floor only.
  const dist: Int32Array[] = goals.map((g) => {
    const d = new Int32Array(size).fill(-1);
    d[g] = 0;
    const q = [g];
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi];
      for (let k = 0; k < 4; k++) {
        const t = p + DIRS[k][1] * w + DIRS[k][0];
        if (t < 0 || t >= size || wall[t] || !live[t] || d[t] !== -1) continue;
        d[t] = d[p] + 1;
        q.push(t);
      }
    }
    return d;
  });
  const perms = permutations(n);
  const hCache = new Map<number, number>();
  const heuristic = (bs: number[]): number => {
    let k = 0;
    for (const b of bs) k = k * size + b;
    const hit = hCache.get(k);
    if (hit !== undefined) return hit;
    let best = Infinity;
    for (const perm of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const dd = dist[perm[i]][bs[i]];
        if (dd < 0) {
          s = Infinity;
          break;
        }
        s += dd;
      }
      if (s < best) best = s;
    }
    hCache.set(k, best);
    return best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const keyOf = (bs: number[], low: number): number | string => {
    if (bs.length <= 5) {
      let k = low;
      for (const b of bs) k = k * size + b;
      return k;
    }
    return `${low}|${bs.join(',')}`;
  };

  // The states, in the order found: boxes, player square, pushes so far, and
  // the push that made them from their parent.
  const boxesArr: number[][] = [startBoxes.slice()];
  const playerArr: number[] = [startPlayer];
  const gArr: number[] = [0];
  const parentArr: number[] = [-1];
  const pushFromArr: number[] = [-1];
  const pushDirArr: number[] = [-1];
  const keyArr: (number | string)[] = [];
  const best = new Map<number | string, number>();
  for (const b of startBoxes) occupied[b] = 1;
  const startLow = regionLow(level, occupied, startPlayer, seen, ++stamp, stack);
  for (const b of startBoxes) occupied[b] = 0;
  keyArr.push(keyOf(startBoxes, startLow));
  best.set(keyArr[0], 0);
  const h0 = heuristic(startBoxes);
  if (h0 === Infinity) return null;

  // Open list: a binary heap on [f, -g, sequence, state], so ties go to the
  // deeper state first, then to the state found first: fully deterministic.
  const heap: [number, number, number, number][] = [];
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1], heap[c])) c++;
        if (!less(heap[c], heap[i])) break;
        [heap[i], heap[c]] = [heap[c], heap[i]];
        i = c;
      }
    }
    return top;
  };
  let seq = 1;
  heapPush([h0, 0, 0, 0]);

  let found = -1;
  while (heap.length > 0) {
    const [, negG, , s] = heapPop();
    const g = -negG;
    if (best.get(keyArr[s]) !== s) continue;
    const bs = boxesArr[s];
    if (solved(bs)) {
      if (!needExit) {
        found = s;
        break;
      }
      for (const b of bs) occupied[b] = 1;
      const out = reachesRow(level, occupied, playerArr[s], hallwayRow, seen, ++stamp, stack);
      for (const b of bs) occupied[b] = 0;
      if (out) {
        found = s;
        break;
      }
      continue;
    }
    for (const b of bs) occupied[b] = 1;
    regionLow(level, occupied, playerArr[s], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi];
      for (let k = 0; k < 4; k++) {
        const d = DIRS[k][1] * w + DIRS[k][0];
        const t = b + d;
        if (t < 0 || t >= size) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        if (seen[b - d] !== here) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        if (!frozen) {
          const nb = bs.slice();
          nb[bi] = t;
          nb.sort((a, c) => a - c);
          const nlow = regionLow(level, occupied, b, mark, ++stamp, stack);
          const key = keyOf(nb, nlow);
          const prev = best.get(key);
          const ng = g + 1;
          if (prev === undefined || gArr[prev] > ng) {
            const h = heuristic(nb);
            if (h !== Infinity) {
              if (boxesArr.length >= maxStates) {
                for (const x of bs) occupied[x] = 0;
                return null;
              }
              const idx = boxesArr.length;
              boxesArr.push(nb);
              playerArr.push(b);
              gArr.push(ng);
              parentArr.push(s);
              pushFromArr.push(b);
              pushDirArr.push(k);
              keyArr.push(key);
              best.set(key, idx);
              heapPush([ng + h, -ng, seq++, idx]);
            }
          }
        }
        occupied[t] = 0;
        occupied[b] = 1;
      }
    }
    for (const b of bs) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parentArr[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = startPlayer;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = boxesArr[s];
    const from = pushFromArr[s];
    const dir = pushDirArr[s];
    const d = DIRS[dir][1] * w + DIRS[dir][0];
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += DIRS[dir][3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, endPlayer: player };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a
 * box there reaches no goal) out of the floor, and each part left that holds
 * a box is a room. Null when a box starts in the hallway, a goal lies outside
 * every part, or a part holds a different count of boxes and goals.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (let k = 0; k < 4; k++) {
        const q = squares[i] + DIRS[k][1] * w + DIRS[k][0];
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) {
    const r = part[b];
    if (r < 0) return null;
    rooms[r].boxes.push(b);
  }
  for (const g of goals) {
    const r = part[g];
    if (r < 0) return null;
    rooms[r].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room is
 * done), the player walking on from where the last room left it. A box never
 * leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level, useExit: boolean): PushSol | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  const hallwayRow = Math.floor(level.player / level.w);
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (let ri = 0; ri < rooms.length; ri++) {
    const room = rooms[ri];
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushAStar(sub, MAX_ROOM_STATES, useExit && ri < rooms.length - 1, hallwayRow);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = solved.endPlayer;
    room.done = true;
  }
  return { pushes, moves, endPlayer: player };
}

/** The moves for a level in XSB: a string of u, d, l and r (an upper letter marks a push; case is not checked). */
function solve(text: string): string {
  const level = parseLevel(text);
  let sol = solveByRooms(level, true);
  if (sol === null) sol = solveByRooms(level, false);
  if (sol === null) sol = solvePushAStar(level, MAX_WHOLE_STATES, false, -1);
  return sol === null ? '' : sol.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
