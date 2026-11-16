import { HIDDEN, neighborTable, type View } from './game.js';

/**
 * Exact mine probabilities for every hidden cell.
 *
 * The idea: every way of placing the mines that agrees with the numbers on
 * the board is equally likely. So
 *
 *   P(cell is a mine) = (valid layouts with a mine there) / (all valid layouts)
 *
 * Counting layouts one by one is hopeless (an expert board has more of them
 * than there are atoms in the universe), so the count is done in four steps:
 *
 *  1. CONSTRAINTS  Each revealed number says "exactly N of my hidden
 *                  neighbours are mines".
 *  2. GROUPS       Hidden cells touched by exactly the same set of numbers
 *                  are interchangeable, so they are merged into one variable
 *                  ("j of these n cells are mines", which can happen C(n, j) ways).
 *  3. COMPONENTS   Groups that share no numbers cannot affect each other, so
 *                  each connected cluster is enumerated on its own by
 *                  backtracking.
 *  4. COMBINE      The clusters are tied back together by the one global
 *                  rule, the total mine count. Mines not used on the border
 *                  must fit in the cells no number touches, which can happen
 *                  C(untouched cells, leftover mines) ways.
 */

export interface Analysis {
  /** Mine probability per cell. NaN for cells that are already revealed. */
  probability: Float64Array;
  /** Hidden cells that are certainly safe. */
  safe: number[];
  /** Hidden cells that are certainly mines. */
  mines: number[];
  /** The least risky hidden cell, for when nothing is certainly safe. */
  guess: number | null;
  /** False if the board was too tangled to enumerate and estimates were used. */
  exact: boolean;
  /** Which independent component each cell was solved in (-1 if none). */
  component: Int16Array;
  /** Numbers describing the work the solver did. */
  stats: SolverStats;
}

export interface SolverStats {
  constraints: number;
  groups: number;
  components: number;
  /** Cells in the biggest component. */
  largestComponent: number;
  /** Hidden cells next to a number, and hidden cells next to none. */
  borderCells: number;
  interiorCells: number;
  /** Backtracking steps taken. */
  nodes: number;
  /** log10 of the number of mine layouts that fit the board. */
  log10Layouts: number;
  /** borderMines[k] = probability that exactly k mines sit on the border. */
  borderMines: number[];
  expectedBorderMines: number;
}

interface Constraint {
  cells: number[];
  mines: number;
}

interface Group {
  cells: number[];
  constraints: number[];
}

interface ComponentResult {
  groups: number[];
  /** counts[k] = number of valid layouts of this component that use k mines. */
  counts: number[];
  /** groupMines[g][k] = mines in group g, summed over those layouts. */
  groupMines: number[][];
}

/** Backtracking steps allowed per analysis before falling back to estimates. */
const NODE_BUDGET = 3_000_000;
const EPSILON = 1e-9;

class BudgetExceeded extends Error {}

// C(n, k) for n <= 8: a group is at most the 8 neighbours of one number.
const CHOOSE: number[][] = [];
for (let n = 0; n <= 8; n++) {
  CHOOSE.push([]);
  for (let k = 0; k <= n; k++) {
    CHOOSE[n].push(k === 0 || k === n ? 1 : CHOOSE[n - 1][k - 1] + CHOOSE[n - 1][k]);
  }
}

// log(n!) table, so huge binomials can be handled as logarithms.
const logFactorial: number[] = [0];
function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  while (logFactorial.length <= n) {
    logFactorial.push(logFactorial[logFactorial.length - 1] + Math.log(logFactorial.length));
  }
  return logFactorial[n] - logFactorial[k] - logFactorial[n - k];
}

/** Polynomial multiplication, dropping terms above `cap`. */
function convolve(a: number[], b: number[], cap: number): number[] {
  const out = new Array<number>(Math.min(a.length + b.length - 1, cap + 1)).fill(0);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length && i + j < out.length; j++) out[i + j] += a[i] * b[j];
  }
  return out;
}

export interface AnalyzeOptions {
  /** Backtracking steps allowed before falling back to estimates. 0 forces estimates. */
  nodeBudget?: number;
}

export function analyze(view: View, options: AnalyzeOptions = {}): Analysis {
  const { width, height, mines: totalMines, cells } = view;
  const size = width * height;
  const neighbors = neighborTable(width, height);
  const probability = new Float64Array(size).fill(NaN);
  const component = new Int16Array(size).fill(-1);

  // --- 1. constraints ---------------------------------------------------------
  const constraints: Constraint[] = [];
  const cellConstraints = new Map<number, number[]>();
  let hiddenCount = 0;
  for (let i = 0; i < size; i++) {
    if (cells[i] === HIDDEN) {
      hiddenCount++;
      continue;
    }
    const hidden = neighbors[i].filter((n) => cells[n] === HIDDEN);
    if (hidden.length === 0) continue;
    const id = constraints.length;
    constraints.push({ cells: hidden, mines: cells[i] });
    for (const cell of hidden) {
      const list = cellConstraints.get(cell);
      if (list) list.push(id);
      else cellConstraints.set(cell, [id]);
    }
  }

  // --- 2. groups --------------------------------------------------------------
  const groups: Group[] = [];
  const groupByKey = new Map<string, number>();
  for (const [cell, ids] of cellConstraints) {
    const key = ids.join(',');
    const existing = groupByKey.get(key);
    if (existing === undefined) {
      groupByKey.set(key, groups.length);
      groups.push({ cells: [cell], constraints: ids });
    } else {
      groups[existing].cells.push(cell);
    }
  }
  const constraintGroups: number[][] = constraints.map(() => []);
  groups.forEach((group, g) => {
    for (const c of group.constraints) constraintGroups[c].push(g);
  });

  // --- 3. components ----------------------------------------------------------
  // Union-find: two groups are in the same component if a number touches both.
  const parent = groups.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const list of constraintGroups) {
    for (let i = 1; i < list.length; i++) parent[find(list[i])] = find(list[0]);
  }
  const componentConstraints = new Map<number, number[]>();
  constraintGroups.forEach((list, c) => {
    const root = find(list[0]);
    const existing = componentConstraints.get(root);
    if (existing) existing.push(c);
    else componentConstraints.set(root, [c]);
  });

  const borderCells = cellConstraints.size;
  const interiorCells = hiddenCount - borderCells;

  let results: ComponentResult[];
  const budget = { nodes: 0, limit: options.nodeBudget ?? NODE_BUDGET };
  try {
    results = [...componentConstraints.values()].map((ids) =>
      enumerateComponent(ids, constraints, groups, constraintGroups, totalMines, budget),
    );
  } catch (err) {
    if (!(err instanceof BudgetExceeded)) throw err;
    return estimate(view, constraints, cellConstraints, hiddenCount, groups.length);
  }

  // --- 4. combine -------------------------------------------------------------
  // prefix[i] = layouts of components 0..i-1 by mine count; suffix likewise.
  const count = results.length;
  const prefix: number[][] = [[1]];
  for (let i = 0; i < count; i++) prefix.push(convolve(prefix[i], results[i].counts, totalMines));
  const suffix: number[][] = new Array(count + 1);
  suffix[count] = [1];
  for (let i = count - 1; i >= 0; i--) {
    suffix[i] = convolve(results[i].counts, suffix[i + 1], totalMines);
  }
  const all = prefix[count];

  // If the border uses k mines, the other (totalMines - k) go in the interior.
  // The binomials are astronomically large, so scale them all by the biggest.
  let scale = -Infinity;
  for (let k = 0; k < all.length; k++) {
    if (all[k] > 0) scale = Math.max(scale, logChoose(interiorCells, totalMines - k));
  }
  if (scale === -Infinity) throw new Error('The board has no valid mine layout');
  const interiorWays = (k: number) => Math.exp(logChoose(interiorCells, totalMines - k) - scale);

  let total = 0;
  for (let k = 0; k < all.length; k++) total += all[k] * interiorWays(k);

  results.forEach((result, i) => {
    // Layouts of every *other* component, by mine count.
    const others = convolve(prefix[i], suffix[i + 1], totalMines);
    const weight = result.counts.map((_, k) => {
      let sum = 0;
      for (let r = 0; r < others.length; r++) sum += others[r] * interiorWays(k + r);
      return sum;
    });
    result.groups.forEach((g, local) => {
      let mineWeight = 0;
      const perCount = result.groupMines[local];
      for (let k = 0; k < perCount.length; k++) mineWeight += perCount[k] * weight[k];
      const p = mineWeight / (groups[g].cells.length * total);
      for (const cell of groups[g].cells) {
        probability[cell] = p;
        component[cell] = i;
      }
    });
  });

  if (interiorCells > 0) {
    // Fix one interior cell as a mine and count what is left.
    let mineWeight = 0;
    for (let k = 0; k < all.length; k++) {
      mineWeight += all[k] * Math.exp(logChoose(interiorCells - 1, totalMines - k - 1) - scale);
    }
    const p = mineWeight / total;
    for (let i = 0; i < size; i++) {
      if (cells[i] === HIDDEN && !cellConstraints.has(i)) probability[i] = p;
    }
  }

  const borderMines: number[] = [];
  let expectedBorderMines = 0;
  for (let k = 0; k < all.length; k++) {
    const p = (all[k] * interiorWays(k)) / total;
    borderMines.push(p);
    expectedBorderMines += k * p;
  }
  const stats: SolverStats = {
    constraints: constraints.length,
    groups: groups.length,
    components: count,
    largestComponent: results.reduce(
      (max, r) => Math.max(max, r.groups.reduce((sum, g) => sum + groups[g].cells.length, 0)),
      0,
    ),
    borderCells,
    interiorCells,
    nodes: budget.nodes,
    log10Layouts: (Math.log(total) + scale) / Math.LN10,
    borderMines,
    expectedBorderMines,
  };

  return summarize(view, probability, true, component, stats);
}

/**
 * Count every valid layout of one component by backtracking over its groups.
 * Before trying values for a group, each number it touches gives a lower and
 * upper bound on how many mines the group can hold, which prunes most branches.
 */
function enumerateComponent(
  constraintIds: number[],
  constraints: Constraint[],
  groups: Group[],
  constraintGroups: number[][],
  totalMines: number,
  budget: { nodes: number; limit: number },
): ComponentResult {
  // Visit groups number by number, so each number is fully decided early.
  const order: number[] = [];
  const seen = new Set<number>();
  let cellCount = 0;
  for (const c of constraintIds) {
    for (const g of constraintGroups[c]) {
      if (!seen.has(g)) {
        seen.add(g);
        order.push(g);
        cellCount += groups[g].cells.length;
      }
    }
  }

  const maxMines = Math.min(totalMines, cellCount);
  const counts = new Array<number>(maxMines + 1).fill(0);
  const groupMines = order.map(() => new Array<number>(maxMines + 1).fill(0));
  const chosen = new Array<number>(order.length).fill(0);

  // Per number: mines still to place, and undecided cells left to place them in.
  const remaining = new Map<number, number>();
  const capacity = new Map<number, number>();
  for (const c of constraintIds) {
    remaining.set(c, constraints[c].mines);
    capacity.set(c, constraints[c].cells.length);
  }

  const search = (pos: number, used: number, ways: number): void => {
    if (++budget.nodes > budget.limit) throw new BudgetExceeded();

    if (pos === order.length) {
      counts[used] += ways;
      for (let i = 0; i < chosen.length; i++) {
        if (chosen[i]) groupMines[i][used] += ways * chosen[i];
      }
      return;
    }

    const group = groups[order[pos]];
    const n = group.cells.length;
    let lo = 0;
    let hi = Math.min(n, maxMines - used);
    for (const c of group.constraints) {
      const need = remaining.get(c)!;
      hi = Math.min(hi, need);
      // The cells of this number that come later can hold at most this many.
      lo = Math.max(lo, need - (capacity.get(c)! - n));
    }
    if (lo > hi) return;

    for (const c of group.constraints) capacity.set(c, capacity.get(c)! - n);
    for (let j = lo; j <= hi; j++) {
      for (const c of group.constraints) remaining.set(c, remaining.get(c)! - j);
      chosen[pos] = j;
      search(pos + 1, used + j, ways * CHOOSE[n][j]);
      for (const c of group.constraints) remaining.set(c, remaining.get(c)! + j);
    }
    chosen[pos] = 0;
    for (const c of group.constraints) capacity.set(c, capacity.get(c)! + n);
  };

  search(0, 0, 1);
  return { groups: order, counts, groupMines };
}

/**
 * Fallback when a board is too tangled to enumerate within the budget: judge
 * each cell by the single most alarming number next to it. Cells that one
 * number alone proves safe or mined are still found.
 */
function estimate(
  view: View,
  constraints: Constraint[],
  cellConstraints: Map<number, number[]>,
  hiddenCount: number,
  groupCount: number,
): Analysis {
  const size = view.width * view.height;
  const probability = new Float64Array(size).fill(NaN);
  let expectedBorderMines = 0;
  for (const [cell, ids] of cellConstraints) {
    let p = 0;
    let safe = false;
    for (const id of ids) {
      const ratio = constraints[id].mines / constraints[id].cells.length;
      if (ratio === 0) safe = true;
      p = Math.max(p, ratio);
    }
    probability[cell] = safe ? 0 : p;
    expectedBorderMines += probability[cell];
  }
  const interior = hiddenCount - cellConstraints.size;
  if (interior > 0) {
    const p = Math.min(1, Math.max(0, (view.mines - expectedBorderMines) / interior));
    for (let i = 0; i < size; i++) {
      if (view.cells[i] === HIDDEN && !cellConstraints.has(i)) probability[i] = p;
    }
  }
  const stats: SolverStats = {
    constraints: constraints.length,
    groups: groupCount,
    components: 0,
    largestComponent: 0,
    borderCells: cellConstraints.size,
    interiorCells: interior,
    nodes: 0,
    log10Layouts: NaN,
    borderMines: [],
    expectedBorderMines,
  };
  return summarize(view, probability, false, new Int16Array(size).fill(-1), stats);
}

function summarize(
  view: View,
  probability: Float64Array,
  exact: boolean,
  component: Int16Array,
  stats: SolverStats,
): Analysis {
  const neighbors = neighborTable(view.width, view.height);
  const safe: number[] = [];
  const mines: number[] = [];
  let guess: number | null = null;
  let guessRisk = Infinity;
  let guessHidden = Infinity;

  for (let i = 0; i < probability.length; i++) {
    let p = probability[i];
    if (Number.isNaN(p)) continue;
    // Snap away floating point noise.
    if (p < EPSILON) p = 0;
    else if (p > 1 - EPSILON) p = 1;
    probability[i] = p;

    if (p === 0) safe.push(i);
    else if (p === 1) mines.push(i);

    // Lowest risk wins. Ties go to the cell with the fewest hidden
    // neighbours (corners, then edges): it is the most likely to be a 0
    // and open up the board.
    let hidden = 0;
    for (const n of neighbors[i]) if (view.cells[n] === HIDDEN) hidden++;
    if (p < guessRisk - EPSILON || (p < guessRisk + EPSILON && hidden < guessHidden)) {
      guess = i;
      guessRisk = p;
      guessHidden = hidden;
    }
  }

  return { probability, safe, mines, guess, exact, component, stats };
}
