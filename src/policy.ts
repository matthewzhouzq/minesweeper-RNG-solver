import { HIDDEN, neighborTable, type View } from './game.js';
import type { Analysis } from './solver.js';

/**
 * The solver works out the odds. The policy decides what to do with them.
 * The default policy plays as well as it can; the other settings exist to
 * make deliberately worse (and more interesting) players.
 */
export interface Policy {
  /** May it click cells that are certainly safe? */
  takeSafe: boolean;
  /** Should it refuse to click cells that are certainly mines? */
  avoidMines: boolean;
  /** Only click cells whose mine probability is inside [minRisk, maxRisk]. */
  minRisk: number;
  maxRisk: number;
  /** Which cell to choose among the ones inside the window. */
  pick: 'safest' | 'riskiest' | 'random';
  /** How to choose between cells with equal risk. */
  tieBreak: 'edges' | 'center' | 'random';
  /** Where to make the first click, which the game guarantees is safe. */
  opening: 'corner' | 'center' | 'random';
  /** Reveal every safe cell in one move, instead of one cell per move. */
  batchSafe: boolean;
  /** Chance per move of clicking a random hidden cell by mistake. */
  blunder: number;
}

export const OPTIMAL: Policy = {
  takeSafe: true,
  avoidMines: true,
  minRisk: 0,
  maxRisk: 1,
  pick: 'safest',
  tieBreak: 'edges',
  opening: 'corner',
  batchSafe: true,
  blunder: 0,
};

export interface Move {
  cells: number[];
  /** Highest mine probability among the chosen cells. */
  risk: number;
  /** False if no cell fit the risk window and the nearest one was used. */
  inWindow: boolean;
  blunder: boolean;
}

const EPSILON = 1e-9;

export function chooseMove(
  view: View,
  analysis: Analysis,
  policy: Policy,
  first: boolean,
  random: () => number = Math.random,
): Move {
  const { width, height, cells } = view;
  const size = width * height;
  const p = analysis.probability;
  const pickRandom = (list: number[]) => list[Math.floor(random() * list.length)];

  const hidden: number[] = [];
  for (let i = 0; i < size; i++) if (cells[i] === HIDDEN) hidden.push(i);

  if (first) {
    const center = Math.floor(height / 2) * width + Math.floor(width / 2);
    const cell = policy.opening === 'corner' ? 0 : policy.opening === 'center' ? center : pickRandom(hidden);
    return { cells: [cell], risk: 0, inWindow: true, blunder: false };
  }

  if (policy.blunder > 0 && random() < policy.blunder) {
    const cell = pickRandom(hidden);
    return { cells: [cell], risk: p[cell], inWindow: true, blunder: true };
  }

  const allowed = (i: number) =>
    !(p[i] === 0 && !policy.takeSafe) && !(p[i] === 1 && policy.avoidMines);
  const inWindow = (i: number) => p[i] >= policy.minRisk - EPSILON && p[i] <= policy.maxRisk + EPSILON;

  // The normal best play: take everything that is certainly safe at once.
  if (policy.takeSafe && policy.batchSafe && policy.pick === 'safest' && policy.minRisk <= 0) {
    if (analysis.safe.length) return { cells: analysis.safe, risk: 0, inWindow: true, blunder: false };
  }

  let pool = hidden.filter((i) => allowed(i) && inWindow(i));
  let fits = true;
  if (pool.length === 0) {
    // Nothing fits the window. Use the cells nearest to it, relaxing the
    // rules one at a time until something is left to click.
    fits = false;
    let fallback = hidden.filter(allowed);
    if (fallback.length === 0) fallback = hidden.filter((i) => !(p[i] === 1 && policy.avoidMines));
    if (fallback.length === 0) fallback = hidden;
    const distance = (i: number) => Math.max(policy.minRisk - p[i], p[i] - policy.maxRisk, 0);
    const nearest = Math.min(...fallback.map(distance));
    pool = fallback.filter((i) => distance(i) <= nearest + EPSILON);
  }

  let candidates: number[];
  if (policy.pick === 'random') {
    candidates = [pickRandom(pool)];
  } else {
    const best =
      policy.pick === 'safest' ? Math.min(...pool.map((i) => p[i])) : Math.max(...pool.map((i) => p[i]));
    candidates = pool.filter((i) => Math.abs(p[i] - best) < EPSILON);
  }

  let cell = candidates[0];
  if (candidates.length > 1) {
    if (policy.tieBreak === 'random') {
      cell = pickRandom(candidates);
    } else if (policy.tieBreak === 'center') {
      const score = (i: number) =>
        Math.abs((i % width) - (width - 1) / 2) + Math.abs(Math.floor(i / width) - (height - 1) / 2);
      cell = candidates.reduce((a, b) => (score(b) < score(a) ? b : a));
    } else {
      // Fewest hidden neighbours: corners and edges, the cells most likely
      // to be a 0 and open up the board.
      const neighbors = neighborTable(width, height);
      const score = (i: number) => neighbors[i].reduce((n, j) => n + (cells[j] === HIDDEN ? 1 : 0), 0);
      cell = candidates.reduce((a, b) => (score(b) < score(a) ? b : a));
    }
  }

  return { cells: [cell], risk: p[cell], inWindow: fits, blunder: false };
}
