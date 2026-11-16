/**
 * The Minesweeper game itself: board, mine placement, revealing cells.
 * The solver never sees this class, only the `View` it exposes.
 */

export const HIDDEN = -1;

export interface BoardConfig {
  width: number;
  height: number;
  mines: number;
}

export type Level = 'beginner' | 'intermediate' | 'expert';

export const LEVELS: Record<Level, BoardConfig> = {
  beginner: { width: 9, height: 9, mines: 10 },
  intermediate: { width: 16, height: 16, mines: 40 },
  expert: { width: 30, height: 16, mines: 99 },
};

/** Everything a player can see: the numbers revealed so far and the mine total. */
export interface View {
  width: number;
  height: number;
  mines: number;
  /** One entry per cell, row by row: HIDDEN, or the revealed number 0-8. */
  cells: ArrayLike<number>;
}

const tables = new Map<string, number[][]>();

/** For each cell index, the indexes of its (up to 8) neighbours. Cached per board size. */
export function neighborTable(width: number, height: number): number[][] {
  const key = `${width}x${height}`;
  let table = tables.get(key);
  if (!table) {
    table = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const list: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if ((dx || dy) && nx >= 0 && nx < width && ny >= 0 && ny < height) {
              list.push(ny * width + nx);
            }
          }
        }
        table.push(list);
      }
    }
    tables.set(key, table);
  }
  return table;
}

/** Small seeded random number generator, so games can be replayed exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type GameState = 'playing' | 'won' | 'lost';

export class Game {
  readonly width: number;
  readonly height: number;
  readonly mineCount: number;
  /** What the player sees. */
  readonly cells: Int8Array;
  state: GameState = 'playing';
  /** The cell that ended the game, if it was lost. */
  lostAt: number | null = null;

  private mineAt: Uint8Array;
  private placed = false;
  private hiddenSafe: number;
  private random: () => number;
  private neighbors: number[][];

  /**
   * Mines are placed on the first reveal, never on the clicked cell or its
   * neighbours, so the first click always opens an area (the rule most
   * modern versions use).
   */
  constructor(config: BoardConfig, seed: number = Date.now()) {
    const size = config.width * config.height;
    if (config.mines < 0 || config.mines >= size) throw new Error('Invalid mine count');
    this.width = config.width;
    this.height = config.height;
    this.mineCount = config.mines;
    this.cells = new Int8Array(size).fill(HIDDEN);
    this.mineAt = new Uint8Array(size);
    this.hiddenSafe = size - config.mines;
    this.random = mulberry32(seed);
    this.neighbors = neighborTable(config.width, config.height);
  }

  /** Build a game with mines at fixed positions. Used by tests. */
  static fromMines(width: number, height: number, mineIndexes: number[]): Game {
    const game = new Game({ width, height, mines: mineIndexes.length });
    for (const i of mineIndexes) game.mineAt[i] = 1;
    game.placed = true;
    return game;
  }

  view(): View {
    return { width: this.width, height: this.height, mines: this.mineCount, cells: this.cells };
  }

  /** Only meaningful to show once the game is over. */
  isMine(index: number): boolean {
    return this.mineAt[index] === 1;
  }

  reveal(index: number): void {
    if (this.state !== 'playing' || this.cells[index] !== HIDDEN) return;
    if (!this.placed) this.placeMines(index);

    if (this.mineAt[index]) {
      this.state = 'lost';
      this.lostAt = index;
      return;
    }

    // Flood fill: a revealed 0 reveals all of its neighbours.
    const stack = [index];
    while (stack.length) {
      const cell = stack.pop()!;
      if (this.cells[cell] !== HIDDEN) continue;
      let count = 0;
      for (const n of this.neighbors[cell]) count += this.mineAt[n];
      this.cells[cell] = count;
      this.hiddenSafe--;
      if (count === 0) {
        for (const n of this.neighbors[cell]) if (this.cells[n] === HIDDEN) stack.push(n);
      }
    }
    if (this.hiddenSafe === 0) this.state = 'won';
  }

  private placeMines(firstClick: number): void {
    const size = this.width * this.height;
    const excluded = new Set([firstClick, ...this.neighbors[firstClick]]);
    let candidates: number[] = [];
    for (let i = 0; i < size; i++) if (!excluded.has(i)) candidates.push(i);
    if (candidates.length < this.mineCount) {
      // Tiny, crowded board: only the clicked cell itself can be kept safe.
      candidates = [];
      for (let i = 0; i < size; i++) if (i !== firstClick) candidates.push(i);
    }
    // Partial Fisher-Yates shuffle: pick `mineCount` distinct candidates.
    for (let i = 0; i < this.mineCount; i++) {
      const j = i + Math.floor(this.random() * (candidates.length - i));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      this.mineAt[candidates[i]] = 1;
    }
    this.placed = true;
  }
}
