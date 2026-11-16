import { LEVELS, type Level } from './game.js';
import { playGame } from './play.js';

/**
 * Win-rate benchmark.
 *
 *   npm run bench                              all three levels, 1000 games each
 *   npm run bench -- --level expert --games 5000 --seed 7
 */
function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const games = Number(option('games') ?? 1000);
const seed = Number(option('seed') ?? 1);
const levelArg = option('level');
const levels = levelArg ? [levelArg as Level] : (Object.keys(LEVELS) as Level[]);

for (const level of levels) {
  const config = LEVELS[level];
  if (!config) {
    console.error(`Unknown level "${level}". Use beginner, intermediate or expert.`);
    process.exit(1);
  }

  let wins = 0;
  let guesses = 0;
  let inexact = 0;
  const start = performance.now();
  for (let i = 0; i < games; i++) {
    const record = playGame(config, seed + i);
    if (record.won) wins++;
    guesses += record.guesses;
    inexact += record.inexact;
  }
  const elapsed = performance.now() - start;

  const rate = wins / games;
  const margin = 1.96 * Math.sqrt((rate * (1 - rate)) / games); // 95% interval
  console.log(
    `${level.padEnd(12)} ${config.width}x${config.height}, ${config.mines} mines | ` +
      `won ${wins}/${games} = ${(rate * 100).toFixed(1)}% (±${(margin * 100).toFixed(1)}) | ` +
      `${(guesses / games).toFixed(2)} guesses/game | ` +
      `${(elapsed / games).toFixed(1)} ms/game | ` +
      `${inexact} estimated analyses`,
  );
}
