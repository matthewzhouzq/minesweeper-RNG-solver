import { Game, type BoardConfig } from './game.js';
import { chooseMove, OPTIMAL, type Policy } from './policy.js';
import { analyze, type AnalyzeOptions } from './solver.js';

export interface GameRecord {
  won: boolean;
  /** Moves that carried some risk. */
  guesses: number;
  /** Analyses that fell back to estimates. */
  inexact: number;
}

/** Let the solver play one game from start to finish. */
export function playGame(
  config: BoardConfig,
  seed: number,
  policy: Policy = OPTIMAL,
  options: AnalyzeOptions = {},
  random: () => number = Math.random,
): GameRecord {
  const game = new Game(config, seed);
  let guesses = 0;
  let inexact = 0;
  let first = true;

  while (game.state === 'playing') {
    const analysis = analyze(game.view(), options);
    if (!analysis.exact) inexact++;
    const move = chooseMove(game.view(), analysis, policy, first, random);
    if (move.risk > 0) guesses++;
    for (const cell of move.cells) game.reveal(cell);
    first = false;
  }

  return { won: game.state === 'won', guesses, inexact };
}
