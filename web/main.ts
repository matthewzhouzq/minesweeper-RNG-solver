import { Game, HIDDEN, LEVELS, type BoardConfig, type GameState, type Level } from '../src/game.js';
import { chooseMove, OPTIMAL, type Move, type Policy } from '../src/policy.js';
import { analyze, type Analysis } from '../src/solver.js';

// --- colours (match the CSS variables in template.html) -----------------------
const C = {
  grid: '#1a1e1d',
  line: '#2a302e',
  dim: '#6b7572',
  text: '#c8d0cd',
  bright: '#f2f5f4',
  accent: '#4fe0a8',
  red: '#ff3b3b',
};
const COMPONENT_SHADES = ['#4fe0a8', '#d7dbd9', '#2a9d78', '#9af0cf', '#7c8885', '#1f6f56'];
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const setText = (id: string, text: string) => {
  el(id).textContent = text;
};

// --- state ----------------------------------------------------------------------
/** One minefield on screen, with the bot's view of it. */
interface Slot {
  id: number;
  game: Game;
  seed: number;
  analysis: Analysis | null;
  lastAnalysis: Analysis | null;
  /** The move the bot will make next, under the current settings. */
  planned: Move | null;
  first: boolean;
  guesses: number;
  /** Chance of having survived every guess taken so far. */
  survival: number;
  /** % of safe cells cleared after each move. */
  progress: number[];
  lastRisk: number;
  /** When a finished field may restart (ms, performance clock). */
  restartAt: number;
  root: HTMLElement;
  status: HTMLElement;
  board: HTMLElement;
  cells: HTMLButtonElement[];
  /** What each cell currently shows, so unchanged cells are not redrawn. */
  cache: string[];
}

let config: BoardConfig = LEVELS.expert;
const slots: Slot[] = [];
/** The field the detail panels describe. Click a field to focus it. */
let focus = 0;
let policy: Policy = { ...OPTIMAL };
let engine: 'exact' | 'estimate' = 'exact';
const display = { heat: true, odds: true };
let auto = true;
let timer: number | undefined;
let delay = 110;
const started = performance.now();

interface Bucket {
  n: number;
  deaths: number;
  risk: number;
}

/** Statistics across every field. */
const session = {
  won: 0,
  lost: 0,
  streak: 0,
  bestStreak: 0,
  winSeries: [] as number[], // cumulative win rate after each game
  times: [] as number[], // ms per analysis
  calibration: [] as Bucket[], // guesses grouped by predicted risk
};

function resetSession(): void {
  session.won = session.lost = session.streak = session.bestStreak = 0;
  session.winSeries = [];
  session.times = [];
  session.calibration = Array.from({ length: 5 }, () => ({ n: 0, deaths: 0, risk: 0 }));
}

// --- logging --------------------------------------------------------------------
function elapsed(): string {
  const s = Math.floor((performance.now() - started) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function log(message: string, kind: '' | 'good' | 'bad' | 'warn' = ''): void {
  const box = el('log');
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = `T+${elapsed()}  ${message}`;
  box.append(line);
  while (box.childElementCount > 80) box.firstElementChild!.remove();
  box.scrollTop = box.scrollHeight;
}

const fieldName = (slot: Slot) => `F${String(slot.id + 1).padStart(2, '0')}`;
const tag = (slot: Slot) => (slots.length > 1 ? `${fieldName(slot)} ` : '');
const coord = (i: number) =>
  `X:${String(i % config.width).padStart(2, '0')} Y:${String(Math.floor(i / config.width)).padStart(2, '0')}`;
const pct = (p: number, digits = 1) => `${(p * 100).toFixed(digits)}%`;

// --- bookkeeping shared by live play and batch simulation ----------------------
function recordGuess(risk: number, died: boolean): void {
  const bucket = session.calibration[Math.min(4, Math.floor(risk * 10))];
  bucket.n++;
  bucket.risk += risk;
  if (died) bucket.deaths++;
}

function recordGame(won: boolean): void {
  if (won) {
    session.won++;
    session.streak++;
    session.bestStreak = Math.max(session.bestStreak, session.streak);
  } else {
    session.lost++;
    session.streak = 0;
  }
  session.winSeries.push((session.won / (session.won + session.lost)) * 100);
  if (session.winSeries.length > 400) session.winSeries.shift();
}

function timedAnalyze(g: Game): Analysis {
  const t0 = performance.now();
  const result = analyze(g.view(), engine === 'estimate' ? { nodeBudget: 0 } : {});
  session.times.push(performance.now() - t0);
  if (session.times.length > 160) session.times.shift();
  return result;
}

// --- fields ---------------------------------------------------------------------
/** Split the field area into `count` minefields that all run at once. */
function buildFields(count: number): void {
  const container = el('fields');
  container.replaceChildren();
  container.dataset.n = String(count);
  // Eight or more fields get the full width of the page.
  el('layout').toggleAttribute('data-wide', count >= 8);
  slots.length = 0;
  focus = 0;

  for (let id = 0; id < count; id++) {
    const root = document.createElement('div');
    root.className = 'fieldbox';
    const caption = document.createElement('button');
    caption.type = 'button';
    caption.className = 'caption';
    const name = document.createElement('span');
    name.textContent = `F${String(id + 1).padStart(2, '0')}`;
    const status = document.createElement('span');
    caption.append(name, status);
    caption.addEventListener('click', () => setFocus(id));
    const wrap = document.createElement('div');
    wrap.className = 'board-wrap';
    const board = document.createElement('div');
    board.className = 'board';
    board.style.setProperty('--cols', String(config.width));
    wrap.append(board);
    root.append(caption, wrap);
    container.append(root);

    const slot: Slot = {
      id,
      game: new Game(config, 0),
      seed: 0,
      analysis: null,
      lastAnalysis: null,
      planned: null,
      first: true,
      guesses: 0,
      survival: 1,
      progress: [],
      lastRisk: 0,
      restartAt: 0,
      root,
      status,
      board,
      cells: [],
      cache: [],
    };
    for (let i = 0; i < config.width * config.height; i++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.addEventListener('click', () => {
        setFocus(id);
        move(slot, [i], true);
        renderPanels();
      });
      cell.addEventListener('mouseenter', () => showReadout(slot, i));
      board.append(cell);
      slot.cells.push(cell);
    }
    slots.push(slot);
    newGame(slot);
  }
  log(`${count} ${count === 1 ? 'FIELD' : 'FIELDS'} ONLINE / ${config.width}x${config.height} / ${config.mines} MINES`);
  renderPanels();
}

function setFocus(id: number): void {
  if (focus === id) return;
  focus = id;
  slots.forEach(renderSlot);
  renderPanels();
}

function newGame(slot: Slot): void {
  slot.seed = Math.floor(Math.random() * 0xffffffff);
  slot.game = new Game(config, slot.seed);
  slot.first = true;
  slot.guesses = 0;
  slot.survival = 1;
  slot.progress = [];
  slot.lastRisk = 0;
  refreshSlot(slot, true);
}

/** Reveal cells, whether chosen by the bot or clicked by a person. */
function move(slot: Slot, targets: number[], manual = false): void {
  const game = slot.game;
  if (game.state !== 'playing') return;
  const first = slot.first;
  const risk = first ? 0 : Math.max(...targets.map((t) => slot.analysis?.probability[t] ?? 0));
  const isGuess = !first && risk > 0;
  const plan = manual ? null : slot.planned;

  for (const t of targets) game.reveal(t);
  const state = game.state as GameState; // reveal() may have ended the game

  slot.first = false;
  slot.lastRisk = risk;
  if (isGuess) {
    slot.guesses++;
    recordGuess(risk, state === 'lost');
    if (state !== 'lost') slot.survival *= 1 - risk;
  }

  // With many fields running, only the important events are logged.
  const who = `${tag(slot)}${manual ? 'MANUAL' : 'SOLVER'}`;
  const chatty = slots.length <= 2;
  if (plan?.blunder) log(`${tag(slot)}BLUNDER: RANDOM CLICK ${coord(targets[0])}`, 'bad');
  if (plan && !plan.inWindow && chatty) log(`${tag(slot)}NOTHING IN RISK WINDOW / USING NEAREST`, 'warn');
  if (first) {
    if (chatty) log(`${who} OPENING ${coord(targets[0])}`);
  } else if (isGuess) {
    if (slots.length <= 4) log(`${who} GUESS ${coord(targets[0])} RISK ${pct(risk)}`, 'warn');
  } else if (chatty) {
    log(`${who} DEDUCED ${targets.length} SAFE`);
  }

  if (state === 'won') {
    recordGame(true);
    log(`${tag(slot)}FIELD CLEARED / ${slot.guesses} GUESSES SURVIVED`, 'good');
  } else if (state === 'lost') {
    recordGame(false);
    log(`${tag(slot)}DETONATION ${coord(game.lostAt!)} ON ${pct(risk)} RISK`, 'bad');
  }
  // Leave a finished field on screen for a moment before it restarts.
  if (state !== 'playing') slot.restartAt = performance.now() + Math.max(900, delay * 6);
  refreshSlot(slot, true);
}

/** Recompute the odds and the next move for one field, then redraw it. */
function refreshSlot(slot: Slot, moved: boolean): void {
  const game = slot.game;
  if (game.state === 'playing') {
    slot.analysis = timedAnalyze(game);
    slot.lastAnalysis = slot.analysis;
    slot.planned = chooseMove(game.view(), slot.analysis, policy, slot.first);
  } else {
    slot.analysis = null;
    slot.planned = null;
  }
  if (moved) {
    let open = 0;
    for (let i = 0; i < game.cells.length; i++) if (game.cells[i] !== HIDDEN) open++;
    slot.progress.push((open / (game.cells.length - config.mines)) * 100);
  }
  renderSlot(slot);
}

/** One move on every field. Finished fields restart once their pause is over. */
function advanceAll(force: boolean): void {
  const now = performance.now();
  for (const slot of slots) {
    if (slot.game.state !== 'playing') {
      if (force || now >= slot.restartAt) newGame(slot);
    } else if (slot.planned) {
      move(slot, slot.planned.cells);
    }
  }
  renderPanels();
}

/** Play games instantly, without drawing them, to fill in the statistics. */
function simulate(games: number): void {
  let wins = 0;
  for (let n = 0; n < games; n++) {
    const g = new Game(config, Math.floor(Math.random() * 0xffffffff));
    let first = true;
    while (g.state === 'playing') {
      const a = timedAnalyze(g);
      const next = chooseMove(g.view(), a, policy, first);
      for (const cell of next.cells) g.reveal(cell);
      if (!first && next.risk > 0) recordGuess(next.risk, (g.state as GameState) === 'lost');
      first = false;
    }
    const won = (g.state as GameState) === 'won';
    if (won) wins++;
    recordGame(won);
  }
  log(`BATCH SIM ${games} GAMES / ${wins} CLEARED`, 'good');
  renderPanels();
}

// --- drawing a field ------------------------------------------------------------
function renderSlot(slot: Slot): void {
  const { game, analysis, planned } = slot;
  const over = game.state !== 'playing';
  const fresh = slot.first;
  const target = new Set(planned && !fresh ? planned.cells : []);

  for (let i = 0; i < slot.cells.length; i++) {
    const value = game.cells[i];
    let cls = '';
    let text = '';
    let risk = '';
    const disabled = over || value !== HIDDEN;

    if (value !== HIDDEN) {
      cls = `open n${value}`;
      if (value > 0) text = String(value);
    } else if (over) {
      if (game.isMine(i)) {
        cls = i === game.lostAt ? 'boom' : 'mine';
        text = i === game.lostAt ? '✸' : '●';
      }
    } else if (!fresh) {
      // (Before the opening click the game guarantees safety, so odds would mislead.)
      const p = analysis!.probability[i];
      if (p === 1) {
        cls = 'flag';
        text = '▲';
      } else if (p === 0) {
        cls = 'safe';
        if (display.odds) {
          cls += ' odds';
          text = '0';
        }
      } else {
        if (display.heat) {
          cls = 'risk';
          risk = p.toFixed(3);
        }
        if (display.odds) {
          cls += ' odds';
          text = String(Math.round(p * 100));
        }
      }
      // Outline the next click when it carries risk, or when it is a single cell.
      if (target.has(i) && (planned!.risk > 0 || target.size === 1)) cls += ' guess';
    }

    const key = `${cls}|${text}|${risk}|${disabled}`;
    if (slot.cache[i] === key) continue;
    slot.cache[i] = key;
    const cell = slot.cells[i];
    cell.className = cls;
    cell.textContent = text;
    if (risk) cell.style.setProperty('--risk', risk);
    else cell.style.removeProperty('--risk');
    cell.disabled = disabled;
  }

  slot.root.dataset.state = game.state;
  slot.root.classList.toggle('focus', slots.length > 1 && slot.id === focus);
  if (game.state === 'won') slot.status.textContent = 'CLEARED';
  else if (game.state === 'lost') slot.status.textContent = `DETONATED ON ${pct(slot.lastRisk, 0)}`;
  else if (fresh) slot.status.textContent = 'READY';
  else {
    const cleared = slot.progress[slot.progress.length - 1] ?? 0;
    slot.status.textContent = `${cleared.toFixed(0)}% / RISK ${pct(planned!.risk, 0)}`;
  }
}

function renderBanner(): void {
  const slot = slots[focus];
  const { game, analysis, planned } = slot;
  const banner = el('banner');
  const prefix = slots.length > 1 ? `${fieldName(slot)} / ` : '';
  banner.dataset.state = game.state;
  let text: string;
  if (game.state === 'won') text = 'FIELD CLEARED';
  else if (game.state === 'lost') text = `DETONATION AT ${coord(game.lostAt!)}`;
  else if (slot.first) text = 'AWAITING OPENING MOVE';
  else if (planned!.risk === 0) {
    const n = planned!.cells.length;
    text = `SAFE MOVE: ${n} ${n === 1 ? 'CELL' : 'CELLS'} QUEUED`;
  } else {
    banner.dataset.state = 'guess';
    const skipped = analysis!.safe.length;
    text =
      `NEXT CLICK ${coord(planned!.cells[0])} / RISK ${pct(planned!.risk)}` +
      (analysis!.exact ? '' : ' (EST)') +
      (skipped ? ` / IGNORING ${skipped} SAFE` : '');
  }
  banner.textContent = prefix + text;
  setText('seed', `0x${slot.seed.toString(16).toUpperCase().padStart(8, '0')}`);
}

function showReadout(slot: Slot, i: number): void {
  const { game, analysis } = slot;
  const value = game.cells[i];
  let detail: string;
  if (value !== HIDDEN) detail = `OPEN / ${value} ADJACENT`;
  else if (game.state !== 'playing') detail = game.isMine(i) ? 'MINE' : 'UNOPENED';
  else if (slot.first || !analysis) detail = 'OPENING IS ALWAYS SAFE';
  else detail = `P(MINE) ${pct(analysis.probability[i], 2)}`;
  setText('readout', `${tag(slot)}SECTOR ${coord(i)} / ${detail}`);
}

// --- numbers --------------------------------------------------------------------
function renderNumbers(): void {
  const slot = slots[focus];
  const played = session.won + session.lost;
  setText('k-win', played ? pct(session.won / played) : '--.-%');
  setText('k-games', `${session.won}W / ${session.lost}L`);
  setText('k-streak', `${session.streak} (BEST ${session.bestStreak})`);
  setText('k-cleared', `${(slot.progress[slot.progress.length - 1] ?? 0).toFixed(1)}%`);
  setText('k-guesses', String(slot.guesses));
  setText('k-survival', pct(slot.survival));
  const ms = session.times[session.times.length - 1];
  setText('k-ms', ms === undefined ? '--' : `${ms.toFixed(2)} MS`);
  setText('focus-name', slots.length > 1 ? `FOCUS ${fieldName(slot)} / CLICK A FIELD TO SWITCH` : 'LIVE');

  const a = slot.lastAnalysis;
  if (!a) return;
  const s = a.stats;
  setText('k-mines', `${a.mines.length} / ${config.mines}`);
  setText('s-constraints', String(s.constraints));
  setText('s-groups', String(s.groups));
  setText('s-components', String(s.components));
  setText('s-largest', `${s.largestComponent} CELLS`);
  setText('s-border', String(s.borderCells));
  setText('s-interior', String(s.interiorCells));
  setText('s-nodes', s.nodes.toLocaleString('en-US'));
  setText('s-layouts', Number.isFinite(s.log10Layouts) ? `10^${s.log10Layouts.toFixed(1)}` : 'N/A');
  setText('s-expected', s.expectedBorderMines.toFixed(2));
  setText('s-mode', a.exact ? 'EXACT' : 'ESTIMATE');
}

/** Everything outside the fields: banner, numbers and charts. */
function renderPanels(): void {
  renderBanner();
  renderNumbers();
  renderCharts();
}

// --- charts ---------------------------------------------------------------------
function canvas(id: string): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const node = el<HTMLCanvasElement>(id);
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = node.getContext('2d');
  } catch {
    return null;
  }
  if (!ctx) return null;
  const dpr = window.devicePixelRatio || 1;
  const w = node.clientWidth;
  const h = node.clientHeight;
  if (w === 0 || h === 0) return null;
  if (node.width !== Math.round(w * dpr) || node.height !== Math.round(h * dpr)) {
    node.width = Math.round(w * dpr);
    node.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = `10px ${FONT}`;
  ctx.textBaseline = 'middle';
  return { ctx, w, h };
}

function awaiting(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = C.dim;
  ctx.textAlign = 'center';
  ctx.fillText('AWAITING DATA', w / 2, h / 2);
}

interface LineOptions {
  min?: number;
  max?: number;
  color?: string;
  ref?: number;
  decimals?: number;
}

function lineChart(id: string, data: number[], opts: LineOptions = {}): void {
  const c = canvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const L = 36;
  const R = 10;
  const T = 8;
  const B = 8;
  const pw = w - L - R;
  const ph = h - T - B;
  const lo = opts.min ?? Math.min(0, ...data);
  let hi = opts.max ?? Math.max(...data, 0);
  if (!(hi - lo > 1e-9)) hi = lo + 1;
  const color = opts.color ?? C.accent;
  const y = (v: number) => T + ph * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));

  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const gy = T + (ph * i) / 3;
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    ctx.moveTo(L, gy + 0.5);
    ctx.lineTo(w - R, gy + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.dim;
    ctx.fillText((hi - ((hi - lo) * i) / 3).toFixed(opts.decimals ?? 0), L - 6, gy);
  }
  if (data.length < 2) {
    awaiting(ctx, w, h);
    return;
  }
  if (opts.ref !== undefined) {
    ctx.strokeStyle = C.dim;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(L, y(opts.ref));
    ctx.lineTo(w - R, y(opts.ref));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const x = (i: number) => L + (pw * i) / (data.length - 1);
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(x(data.length - 1), T + ph);
  ctx.lineTo(L, T + ph);
  ctx.closePath();
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.bright;
  ctx.beginPath();
  ctx.arc(x(data.length - 1), y(data[data.length - 1]), 2.5, 0, Math.PI * 2);
  ctx.fill();
}

interface BarOptions {
  color?: (i: number) => string;
  max?: number;
  /** A second value per bar, drawn as a hollow outline. */
  outline?: number[];
  format?: (v: number) => string;
}

function barChart(id: string, values: number[], labels: string[], opts: BarOptions = {}): void {
  const c = canvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const L = 8;
  const R = 8;
  const T = 16;
  const B = 16;
  const pw = w - L - R;
  const ph = h - T - B;
  const n = values.length;
  if (n === 0 || values.every((v) => v === 0) && !(opts.outline ?? []).some((v) => v > 0)) {
    awaiting(ctx, w, h);
    return;
  }
  const max = opts.max ?? Math.max(...values, ...(opts.outline ?? []), 1e-9);
  const gap = Math.max(2, Math.min(6, pw / n / 4));
  const bw = (pw - gap * (n - 1)) / n;

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L, T + ph + 0.5);
  ctx.lineTo(w - R, T + ph + 0.5);
  ctx.stroke();

  ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const x = L + i * (bw + gap);
    const bh = (ph * Math.min(values[i], max)) / max;
    ctx.fillStyle = opts.color ? opts.color(i) : C.accent;
    ctx.fillRect(x, T + ph - bh, bw, bh);
    if (opts.outline) {
      const oh = (ph * Math.min(opts.outline[i], max)) / max;
      ctx.strokeStyle = C.bright;
      ctx.strokeRect(x + 0.5, T + ph - oh + 0.5, bw - 1, oh);
    }
    ctx.fillStyle = C.dim;
    ctx.fillText(labels[i], x + bw / 2, T + ph + 9);
    if (opts.format && values[i] > 0 && bw >= 18) {
      ctx.fillStyle = C.text;
      ctx.fillText(opts.format(values[i]), x + bw / 2, T + ph - bh - 7);
    }
  }
}

function gauge(id: string, value: number | null, label: string): void {
  const c = canvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const cx = w / 2;
  const cy = h - 16;
  const r = Math.max(10, Math.min(w / 2 - 14, h - 30));
  ctx.lineWidth = 8;
  ctx.strokeStyle = C.grid;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI * 2);
  ctx.stroke();
  if (value !== null && value > 0) {
    ctx.strokeStyle = C.red;
    ctx.beginPath();
    ctx.arc(cx, cy, r, Math.PI, Math.PI * (1 + Math.min(1, value)));
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  ctx.strokeStyle = C.dim;
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (1 + i / 10);
    const inner = r + 7;
    const outer = r + (i % 5 === 0 ? 13 : 10);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = value !== null && value > 0 ? C.red : C.accent;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(value === null ? '--' : pct(value), cx, cy - r * 0.38);
  ctx.font = `10px ${FONT}`;
  ctx.fillStyle = C.dim;
  ctx.fillText(label, cx, cy - 2);
}

/** Small map of the focused field, coloured by which independent region solved each cell. */
function componentMap(id: string): void {
  const c = canvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const slot = slots[focus];
  const a = slot.lastAnalysis;
  const cells = slot.game.cells;
  const size = Math.max(1, Math.floor(Math.min(w / config.width, h / config.height)));
  const ox = Math.floor((w - size * config.width) / 2);
  const oy = Math.floor((h - size * config.height) / 2);
  for (let i = 0; i < cells.length; i++) {
    const x = ox + (i % config.width) * size;
    const y = oy + Math.floor(i / config.width) * size;
    if (cells[i] !== HIDDEN) ctx.fillStyle = '#0b0c0c';
    else if (!a || slot.first) ctx.fillStyle = C.grid;
    else if (a.probability[i] === 1) ctx.fillStyle = C.red;
    else if (a.component[i] >= 0) ctx.fillStyle = COMPONENT_SHADES[a.component[i] % COMPONENT_SHADES.length];
    else ctx.fillStyle = C.line;
    ctx.fillRect(x, y, size - 1, size - 1);
  }
}

function renderCharts(): void {
  const slot = slots[focus];
  const { game, analysis, planned } = slot;
  const a = slot.lastAnalysis;
  const live = analysis !== null && !slot.first;

  // Risk of the move about to be made.
  if (!live) gauge('c-gauge', null, game.state === 'playing' ? 'STANDBY' : 'FIELD CLOSED');
  else gauge('c-gauge', planned!.risk, 'NEXT MOVE RISK');

  componentMap('c-map');

  lineChart('c-win', session.winSeries, { min: 0, max: 100, ref: 50 });
  lineChart('c-time', session.times, { min: 0, decimals: 1, color: C.text });
  lineChart('c-progress', slot.progress, { min: 0, max: 100 });

  // How the hidden cells split by risk.
  const riskLabels = ['SAFE', '<10', '<20', '<30', '<40', '<50', '50+', 'MINE'];
  const risk = new Array<number>(8).fill(0);
  if (live) {
    for (let i = 0; i < game.cells.length; i++) {
      if (game.cells[i] !== HIDDEN) continue;
      const p = analysis!.probability[i];
      if (p === 0) risk[0]++;
      else if (p === 1) risk[7]++;
      else risk[1 + Math.min(5, Math.floor(p * 10))]++;
    }
  }
  // Once a field is finished, keep the last live picture on screen.
  const redraw = live || slot.first;
  if (redraw) {
    barChart('c-risk', risk, riskLabels, {
      color: (i) => (i === 0 ? C.accent : i >= 6 ? C.red : C.dim),
      format: (v) => String(v),
    });
  }

  // Chance of each possible number of mines next to revealed numbers.
  const dist = live && a ? a.stats.borderMines : [];
  let from = dist.findIndex((p) => p > 0.002);
  let to = dist.length - 1;
  while (to > from && dist[to] <= 0.002) to--;
  if (from === -1) from = to + 1;
  const slice = dist.slice(from, to + 1);
  if (redraw) {
    barChart(
      'c-border',
      slice,
      slice.map((_, i) => String(from + i)),
      { color: () => C.text },
    );
  }

  // Calibration: did guesses the bot called X% risky blow up X% of the time?
  const buckets = session.calibration;
  barChart(
    'c-calib',
    buckets.map((b) => (b.n ? b.deaths / b.n : 0)),
    ['0-10', '10-20', '20-30', '30-40', '40+'],
    {
      max: 0.6,
      color: () => C.red,
      outline: buckets.map((b) => (b.n ? b.risk / b.n : 0)),
      format: (v) => `${Math.round(v * 100)}`,
    },
  );
  const guesses = buckets.reduce((sum, b) => sum + b.n, 0);
  setText('calib-n', `${guesses} GUESSES`);

  // Revealed numbers on the focused field.
  const numbers = new Array<number>(9).fill(0);
  for (let i = 0; i < game.cells.length; i++) if (game.cells[i] >= 0) numbers[game.cells[i]]++;
  barChart('c-nums', numbers, ['0', '1', '2', '3', '4', '5', '6', '7', '8'], {
    color: (i) => (i === 0 ? C.line : C.accent),
  });
}

// --- loop and controls ----------------------------------------------------------
function tick(): void {
  if (!auto) return;
  advanceAll(false);
  timer = window.setTimeout(tick, delay);
}

function setAuto(on: boolean): void {
  auto = on;
  window.clearTimeout(timer);
  const button = el('auto');
  button.textContent = on ? 'PAUSE' : 'AUTO';
  button.setAttribute('aria-pressed', String(on));
  setText('mode', on ? 'AUTONOMOUS' : 'MANUAL');
  if (on) timer = window.setTimeout(tick, delay);
}

el('new').addEventListener('click', () => {
  slots.forEach(newGame);
  renderPanels();
});
el('step').addEventListener('click', () => {
  setAuto(false);
  advanceAll(true);
});
el('auto').addEventListener('click', () => setAuto(!auto));
el('sim').addEventListener('click', () => {
  const button = el<HTMLButtonElement>('sim');
  button.disabled = true;
  button.textContent = 'RUNNING';
  window.setTimeout(() => {
    simulate(100);
    button.disabled = false;
    button.textContent = 'SIM +100';
  }, 30);
});
el<HTMLSelectElement>('level').addEventListener('change', (event) => {
  config = LEVELS[(event.target as HTMLSelectElement).value as Level];
  resetSession();
  log('DIFFICULTY CHANGED / SESSION STATS RESET', 'warn');
  buildFields(slots.length);
});
el<HTMLSelectElement>('count').addEventListener('change', (event) => {
  buildFields(Number((event.target as HTMLSelectElement).value));
});
el<HTMLInputElement>('speed').addEventListener('input', (event) => {
  delay = Number((event.target as HTMLInputElement).value);
  setText('speed-value', `${delay} MS`);
});
window.addEventListener('resize', renderCharts);
window.setInterval(() => setText('clock', `T+${elapsed()}`), 1000);

// --- settings -------------------------------------------------------------------
const check = (id: string) => el<HTMLInputElement>(id);
const PRESETS: Record<string, { policy: Policy; engine: 'exact' | 'estimate' }> = {
  optimal: { policy: OPTIMAL, engine: 'exact' },
  nofreebies: { policy: { ...OPTIMAL, takeSafe: false }, engine: 'exact' },
  daredevil: { policy: { ...OPTIMAL, takeSafe: false, minRisk: 0.25 }, engine: 'exact' },
  coinflip: { policy: { ...OPTIMAL, pick: 'random', tieBreak: 'random', opening: 'random' }, engine: 'exact' },
  sloppy: { policy: { ...OPTIMAL, blunder: 0.08 }, engine: 'exact' },
  gutfeel: { policy: OPTIMAL, engine: 'estimate' },
  kamikaze: { policy: { ...OPTIMAL, pick: 'riskiest', avoidMines: false }, engine: 'exact' },
};

/** Push a policy into the form controls. */
function showSettings(): void {
  check('p-safe').checked = policy.takeSafe;
  check('p-mines').checked = policy.avoidMines;
  check('p-batch').checked = policy.batchSafe;
  check('p-min').value = String(Math.round(policy.minRisk * 100));
  check('p-max').value = String(Math.round(policy.maxRisk * 100));
  check('p-blunder').value = String(Math.round(policy.blunder * 100));
  el<HTMLSelectElement>('p-pick').value = policy.pick;
  el<HTMLSelectElement>('p-tie').value = policy.tieBreak;
  el<HTMLSelectElement>('p-open').value = policy.opening;
  el<HTMLSelectElement>('p-engine').value = engine;
  describeSettings();
}

function describeSettings(): void {
  const lo = Math.round(policy.minRisk * 100);
  const hi = Math.round(policy.maxRisk * 100);
  setText('p-min-v', `${lo}%`);
  setText('p-max-v', `${hi}%`);
  setText('p-blunder-v', `${Math.round(policy.blunder * 100)}%`);
  const bar = el('p-window');
  bar.style.left = `${lo}%`;
  bar.style.width = `${Math.max(1, hi - lo)}%`;

  const pick = { safest: 'THE LOWEST-RISK', riskiest: 'THE HIGHEST-RISK', random: 'A RANDOM' }[policy.pick];
  const parts = [`CLICKS ${pick} CELL WITH RISK BETWEEN ${lo}% AND ${hi}%.`];
  parts.push(policy.takeSafe ? 'TAKES GUARANTEED-SAFE CELLS.' : 'REFUSES GUARANTEED-SAFE CELLS.');
  if (!policy.avoidMines) parts.push('WILL CLICK CELLS IT KNOWS ARE MINES.');
  if (policy.blunder > 0) parts.push(`MISCLICKS ${Math.round(policy.blunder * 100)}% OF THE TIME.`);
  parts.push(engine === 'exact' ? 'ODDS ARE EXACT.' : 'ODDS ARE ROUGH ESTIMATES.');
  parts.push('IF NOTHING FITS, IT CLICKS THE NEAREST CELL TO THE WINDOW.');
  setText('p-summary', parts.join(' '));

  const match = Object.entries(PRESETS).find(
    ([, preset]) => preset.engine === engine && JSON.stringify(preset.policy) === JSON.stringify(policy),
  );
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.preset === match?.[0]));
  });
}

/** Behaviour changed: old statistics no longer describe this bot. */
function settingsChanged(message: string): void {
  describeSettings();
  resetSession();
  log(`${message} / SESSION STATS RESET`, 'warn');
  for (const slot of slots) refreshSlot(slot, false);
  renderPanels();
}

function readSettings(changed?: string): void {
  let lo = Number(check('p-min').value);
  let hi = Number(check('p-max').value);
  // Keep the window valid by dragging the other end along.
  if (lo > hi) {
    if (changed === 'p-min') hi = lo;
    else lo = hi;
    check('p-min').value = String(lo);
    check('p-max').value = String(hi);
  }
  policy = {
    takeSafe: check('p-safe').checked,
    avoidMines: check('p-mines').checked,
    batchSafe: check('p-batch').checked,
    minRisk: lo / 100,
    maxRisk: hi / 100,
    blunder: Number(check('p-blunder').value) / 100,
    pick: el<HTMLSelectElement>('p-pick').value as Policy['pick'],
    tieBreak: el<HTMLSelectElement>('p-tie').value as Policy['tieBreak'],
    opening: el<HTMLSelectElement>('p-open').value as Policy['opening'],
  };
  engine = el<HTMLSelectElement>('p-engine').value as typeof engine;
}

for (const id of ['p-safe', 'p-mines', 'p-batch', 'p-min', 'p-max', 'p-blunder', 'p-pick', 'p-tie', 'p-open', 'p-engine']) {
  // Sliders update their labels while dragging and apply on release.
  el(id).addEventListener('input', () => {
    readSettings(id);
    describeSettings();
  });
  el(id).addEventListener('change', () => {
    readSettings(id);
    settingsChanged('SOLVER SETTINGS CHANGED');
  });
}
document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button) => {
  button.addEventListener('click', () => {
    const preset = PRESETS[button.dataset.preset!];
    policy = { ...preset.policy };
    engine = preset.engine;
    showSettings();
    settingsChanged(`PRESET ${button.textContent}`);
  });
});
check('d-heat').addEventListener('change', (event) => {
  display.heat = (event.target as HTMLInputElement).checked;
  slots.forEach(renderSlot);
});
function setOdds(on: boolean): void {
  display.odds = on;
  check('d-odds').checked = on;
  const button = el('odds');
  button.textContent = on ? '% ON' : '% OFF';
  button.setAttribute('aria-pressed', String(on));
  slots.forEach(renderSlot);
}
check('d-odds').addEventListener('change', (event) => setOdds((event.target as HTMLInputElement).checked));
el('odds').addEventListener('click', () => setOdds(!display.odds));
el('reset').addEventListener('click', () => {
  resetSession();
  log('SESSION STATS RESET', 'warn');
  renderPanels();
});

resetSession();
buildFields(1);
showSettings();
setAuto(true);
