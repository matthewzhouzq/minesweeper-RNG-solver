import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Game, HIDDEN, LEVELS, mulberry32, neighborTable, type View } from '../src/game.js';
import { playGame } from '../src/play.js';
import { chooseMove, OPTIMAL, type Policy } from '../src/policy.js';
import { analyze } from '../src/solver.js';

/**
 * The slow, obviously-correct way: try every placement of the mines on the
 * hidden cells, keep the ones that agree with every revealed number, and
 * count how often each cell holds a mine.
 */
function bruteForce(view: View): Map<number, number> {
  const size = view.width * view.height;
  const neighbors = neighborTable(view.width, view.height);
  const hidden: number[] = [];
  for (let i = 0; i < size; i++) if (view.cells[i] === HIDDEN) hidden.push(i);

  const mine = new Uint8Array(size);
  const hits = new Map<number, number>(hidden.map((i) => [i, 0]));
  let valid = 0;

  const consistent = () => {
    for (let i = 0; i < size; i++) {
      if (view.cells[i] === HIDDEN) continue;
      let count = 0;
      for (const n of neighbors[i]) count += mine[n];
      if (count !== view.cells[i]) return false;
    }
    return true;
  };

  const place = (start: number, left: number) => {
    if (left === 0) {
      if (consistent()) {
        valid++;
        for (const i of hidden) if (mine[i]) hits.set(i, hits.get(i)! + 1);
      }
      return;
    }
    for (let i = start; i <= hidden.length - left; i++) {
      mine[hidden[i]] = 1;
      place(i + 1, left - 1);
      mine[hidden[i]] = 0;
    }
  };
  place(0, view.mines);

  assert.ok(valid > 0, 'brute force found no valid layout');
  return new Map([...hits].map(([cell, count]) => [cell, count / valid]));
}

function assertMatchesBruteForce(view: View, label: string) {
  const analysis = analyze(view);
  assert.ok(analysis.exact, `${label}: expected an exact analysis`);
  for (const [cell, expected] of bruteForce(view)) {
    const actual = analysis.probability[cell];
    assert.ok(
      Math.abs(actual - expected) < 1e-9,
      `${label}: cell ${cell} expected ${expected} but got ${actual}`,
    );
  }
}

describe('game', () => {
  it('never puts a mine on or next to the first click', () => {
    for (let seed = 0; seed < 200; seed++) {
      const game = new Game(LEVELS.expert, seed);
      game.reveal(100);
      assert.equal(game.state, 'playing');
      assert.equal(game.cells[100], 0);
    }
  });

  it('places the right number of mines', () => {
    const game = new Game(LEVELS.intermediate, 5);
    game.reveal(0);
    let mines = 0;
    for (let i = 0; i < 256; i++) if (game.isMine(i)) mines++;
    assert.equal(mines, 40);
  });

  it('is reproducible from a seed', () => {
    const a = new Game(LEVELS.beginner, 42);
    const b = new Game(LEVELS.beginner, 42);
    a.reveal(40);
    b.reveal(40);
    assert.deepEqual([...a.cells], [...b.cells]);
  });

  it('loses on a mine and wins when every safe cell is open', () => {
    // 3x1 board: mine on the left.
    const lost = Game.fromMines(3, 1, [0]);
    lost.reveal(0);
    assert.equal(lost.state, 'lost');
    assert.equal(lost.lostAt, 0);

    const won = Game.fromMines(3, 1, [0]);
    won.reveal(2); // a 0, which floods into the 1 beside the mine
    assert.equal(won.state, 'won');
    assert.deepEqual([...won.cells], [HIDDEN, 1, 0]);
  });
});

describe('solver', () => {
  it('gives every cell the same odds on an untouched board', () => {
    const view: View = { width: 4, height: 4, mines: 4, cells: new Array(16).fill(HIDDEN) };
    const { probability } = analyze(view);
    for (const p of probability) assert.ok(Math.abs(p - 0.25) < 1e-12);
  });

  it('solves the classic 1-2-1 pattern', () => {
    //  1 2 1     the mines must be under the two 1s,
    //  ? ? ?     and the middle cell is safe
    const view: View = { width: 3, height: 2, mines: 2, cells: [1, 2, 1, HIDDEN, HIDDEN, HIDDEN] };
    const analysis = analyze(view);
    assert.deepEqual([...analysis.probability.slice(3)], [1, 0, 1]);
    assert.deepEqual(analysis.safe, [4]);
    assert.deepEqual(analysis.mines, [3, 5]);
  });

  it('uses the total mine count', () => {
    //  1 ? ?     Without the mine count, the far cell is a coin flip.
    //            With exactly 1 mine on the board, it must be safe.
    const view: View = { width: 3, height: 1, mines: 1, cells: [1, HIDDEN, HIDDEN] };
    assert.deepEqual([...analyze(view).probability.slice(1)], [1, 0]);
    //            With 2 mines, both hidden cells are mines.
    assert.deepEqual([...analyze({ ...view, mines: 2 }).probability.slice(1)], [1, 1]);
  });

  it('breaks ties toward corners', () => {
    const view: View = { width: 5, height: 5, mines: 5, cells: new Array(25).fill(HIDDEN) };
    assert.ok([0, 4, 20, 24].includes(analyze(view).guess!));
  });

  it('matches brute force at every step of 60 random small games', () => {
    const boards = [
      { width: 5, height: 5, mines: 5 },
      { width: 6, height: 4, mines: 6 },
      { width: 4, height: 4, mines: 7 }, // crowded: lots of forced guesses
    ];
    let positions = 0;
    for (const config of boards) {
      for (let seed = 0; seed < 20; seed++) {
        const game = new Game(config, seed);
        game.reveal(seed % (config.width * config.height));
        while (game.state === 'playing') {
          assertMatchesBruteForce(game.view(), `${config.width}x${config.height} seed ${seed}`);
          positions++;
          const analysis = analyze(game.view());
          if (analysis.safe.length) for (const cell of analysis.safe) game.reveal(cell);
          else game.reveal(analysis.guess!);
        }
      }
    }
    assert.ok(positions > 100, `only checked ${positions} positions`);
  });

  it('never loses on a cell it called safe', () => {
    for (let seed = 0; seed < 100; seed++) {
      const game = new Game(LEVELS.intermediate, seed);
      game.reveal(0);
      while (game.state === 'playing') {
        const analysis = analyze(game.view());
        for (const cell of analysis.safe) assert.ok(!game.isMine(cell), `seed ${seed}: "safe" cell ${cell} is a mine`);
        for (const cell of analysis.mines) assert.ok(game.isMine(cell), `seed ${seed}: "mine" cell ${cell} is safe`);
        if (analysis.safe.length) for (const cell of analysis.safe) game.reveal(cell);
        else game.reveal(analysis.guess!);
      }
    }
  });

  it('wins most beginner games', () => {
    let wins = 0;
    for (let seed = 0; seed < 200; seed++) if (playGame(LEVELS.beginner, seed).won) wins++;
    assert.ok(wins > 160, `only won ${wins}/200`);
  });
});

describe('policy', () => {
  // Play a game with a policy and report the risk of every non-opening move.
  function risksTaken(policy: Policy, seed: number): { risks: number[]; safeAvailable: boolean[] } {
    const rng = mulberry32(seed);
    const game = new Game(LEVELS.beginner, seed);
    const risks: number[] = [];
    const safeAvailable: boolean[] = [];
    let first = true;
    while (game.state === 'playing') {
      const analysis = analyze(game.view());
      const move = chooseMove(game.view(), analysis, policy, first, rng);
      if (!first) {
        risks.push(move.risk);
        const riskyOptions = [...analysis.probability].some((p) => p > 0 && p < 1);
        safeAvailable.push(riskyOptions);
      }
      for (const cell of move.cells) game.reveal(cell);
      first = false;
    }
    return { risks, safeAvailable };
  }

  it('the default policy never gambles while a safe cell exists', () => {
    for (let seed = 0; seed < 50; seed++) {
      const game = new Game(LEVELS.beginner, seed);
      let first = true;
      while (game.state === 'playing') {
        const analysis = analyze(game.view());
        const move = chooseMove(game.view(), analysis, OPTIMAL, first);
        if (!first && analysis.safe.length) assert.equal(move.risk, 0);
        for (const cell of move.cells) game.reveal(cell);
        first = false;
      }
    }
  });

  it('can be told to skip guaranteed-safe cells', () => {
    const policy: Policy = { ...OPTIMAL, takeSafe: false };
    for (let seed = 0; seed < 50; seed++) {
      const { risks, safeAvailable } = risksTaken(policy, seed);
      risks.forEach((risk, i) => {
        // It may only click a 0% cell when no risky cell was left to click.
        if (safeAvailable[i]) assert.ok(risk > 0, `seed ${seed}: clicked a safe cell`);
      });
    }
  });

  it('respects the risk window when a cell fits it', () => {
    const policy: Policy = { ...OPTIMAL, minRisk: 0.2, maxRisk: 0.6, pick: 'random' };
    for (let seed = 0; seed < 50; seed++) {
      const rng = mulberry32(seed);
      const game = new Game(LEVELS.beginner, seed);
      let first = true;
      while (game.state === 'playing') {
        const analysis = analyze(game.view());
        const move = chooseMove(game.view(), analysis, policy, first, rng);
        if (!first && move.inWindow) assert.ok(move.risk >= 0.2 - 1e-9 && move.risk <= 0.6 + 1e-9);
        for (const cell of move.cells) game.reveal(cell);
        first = false;
      }
    }
  });

  it('never clicks a certain mine unless allowed to', () => {
    const policy: Policy = { ...OPTIMAL, pick: 'riskiest' };
    for (let seed = 0; seed < 50; seed++) {
      for (const risk of risksTaken(policy, seed).risks) assert.ok(risk < 1);
    }
    const reckless: Policy = { ...OPTIMAL, pick: 'riskiest', avoidMines: false };
    assert.ok(!playGame(LEVELS.beginner, 3, reckless).won);
  });

  it('plays worse with estimates than with exact odds', () => {
    let exact = 0;
    let estimated = 0;
    for (let seed = 0; seed < 300; seed++) {
      if (playGame(LEVELS.intermediate, seed).won) exact++;
      if (playGame(LEVELS.intermediate, seed, OPTIMAL, { nodeBudget: 0 }).won) estimated++;
    }
    assert.ok(exact > estimated, `exact ${exact} vs estimated ${estimated}`);
  });
});
