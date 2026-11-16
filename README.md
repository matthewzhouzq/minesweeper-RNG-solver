# minesweeper-RNG-solver

A Minesweeper solver that computes the **exact** probability that each hidden cell is a mine, then plays the safest move. TypeScript, no runtime dependencies.

Open `demo.html` in a browser for a live dashboard: the solver plays continuously while the page charts its win rate, the risk on every hidden cell, how well its predicted risks match what happens, and the internals of each analysis. You can also click cells and play yourself, or press SIM +100 to run a hundred games instantly.

The dashboard also has:

- **1, 2, 4, 8 or 16 fields at once.** The field area splits into that many boards, all playing together. Click a field to point the detail panels at it.
- **Solver settings.** A risk window (the bot only clicks cells between a minimum and maximum risk), switches for taking guaranteed-safe cells and avoiding certain mines, how it picks and breaks ties, a misclick rate, and an exact or estimated odds engine. Presets such as DAREDEVIL and KAMIKAZE set these in one click. The logic lives in `src/policy.ts`.
- **Risk % on every hidden cell**, with a toggle.

## Results

Measured with `npm run bench` (seed 1). The first click is always safe and opens an area, as in most modern versions of the game.

| Level | Board | Win rate | Games | Guesses per game | Time per game |
| --- | --- | --- | --- | --- | --- |
| Beginner | 9x9, 10 mines | 95.3% (±1.3) | 1,000 | 0.28 | 0.3 ms |
| Intermediate | 16x16, 40 mines | 84.5% (±2.2) | 1,000 | 0.84 | 0.8 ms |
| Expert | 30x16, 99 mines | 45.7% (±1.4) | 5,000 | 3.13 | 5.5 ms |

The ± is a 95% confidence interval. Every analysis in these runs was exact; none hit the fallback.

Most expert losses are unavoidable: the solver is forced to guess about three times a game, and some of those are true 50/50s.

## Run it

```sh
npm install
npm test          # 16 tests
npm run bench     # win rates on all three levels
npm run bench -- --level expert --games 5000 --seed 7
npm run demo      # rebuild demo.html after changing the code
```

## How it works

Every mine layout that agrees with the numbers on the board is equally likely, so

    P(cell is a mine) = layouts with a mine there / all valid layouts

An expert board has far too many layouts to list, so `src/solver.ts` counts them in four steps:

1. **Constraints.** Each revealed number says "exactly N of my hidden neighbours are mines".
2. **Groups.** Hidden cells touched by exactly the same numbers are interchangeable, so they merge into one variable: "j of these n cells are mines", which can happen C(n, j) ways.
3. **Components.** Clusters of groups that share no numbers can't affect each other. Each is enumerated separately by backtracking, with bounds from each number pruning the search.
4. **Combine.** The clusters are joined by the one global rule, the total mine count. Mines not used next to numbers must fit in the untouched cells, which can happen C(untouched, leftover) ways. Those binomials are astronomically large, so they are handled as logarithms.

When no cell is certainly safe, the solver clicks the lowest-risk cell, breaking ties toward corners and edges, which are the most likely to open up the board.

## Is it correct?

The main test replays 60 random small games and, at every position, compares the solver's probabilities with a brute-force count over every possible mine placement. They agree to nine decimal places. Another test checks, across 100 intermediate games, that every cell called "safe" really is safe and every cell called "mine" really is a mine.

## Files

| File | What it does |
| --- | --- |
| `src/game.ts` | The game: board, seeded mine placement, revealing cells |
| `src/solver.ts` | The probability engine |
| `src/policy.ts` | Chooses a move from the odds, under adjustable settings |
| `src/play.ts` | Plays one full game with the solver |
| `src/bench.ts` | Win-rate benchmark |
| `web/` | Source for the demo page |
| `test/solver.test.ts` | Tests, including the brute-force check |

## Ideas for going further

- **Smarter guessing.** The solver picks the lowest-risk cell. The best solvers also weigh how much information a guess will reveal, and are reported to win over half of expert games under similar rules (worth verifying before quoting).
- **Endgame search.** With few cells left, search every line of play to find the move with the best chance of winning the whole game, not the safest single click.
- **Classic rules.** Add a mode where only the first clicked cell is safe, and compare win rates.
- **Read a real game.** Take a screenshot of a Minesweeper window and overlay the probabilities.
