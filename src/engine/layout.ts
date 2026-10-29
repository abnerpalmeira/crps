import { OPPOSITE, dirTowards } from './text';
import type { Dir, Fixture, FixtureKind, FloorStyle, Location, Pos } from './types';

type FacingRule = 'interior' | 'board' | 'away_board' | 'table' | 'open_side' | 'none';

export interface TileDef {
  char: string;
  kind: 'wall' | 'floor' | 'void' | FixtureKind;
  label: string;
  /** Prefixo dos ids de móveis (`sala/carteira-3`). */
  slug: string;
  passable: boolean;
  /** Faz parte da linha da parede (porta, janela, quadro). */
  wall: boolean;
  seat: boolean;
  /** Caracteres iguais vizinhos viram um único móvel de vários tiles. */
  merge: boolean;
  facing: FacingRule;
}

function tile(char: string, kind: TileDef['kind'], label: string, slug: string, opts: Partial<TileDef> = {}): TileDef {
  return { char, kind, label, slug, passable: false, wall: false, seat: false, merge: false, facing: 'none', ...opts };
}

export const LEGEND: Record<string, TileDef> = Object.fromEntries(
  [
    tile('#', 'wall', 'parede', 'parede', { wall: true }),
    tile('.', 'floor', 'chão', 'chao', { passable: true }),
    tile(' ', 'void', 'vazio/exterior', 'vazio'),
    tile('D', 'door', 'porta', 'porta', { passable: true, wall: true, facing: 'interior' }),
    tile('W', 'window', 'janela', 'janela', { wall: true, merge: true, facing: 'interior' }),
    tile('B', 'board', 'quadro-negro', 'quadro', { wall: true, merge: true, facing: 'interior' }),
    tile('T', 'teacher_desk', 'mesa do professor', 'mesa-prof', { merge: true, facing: 'away_board' }),
    tile('d', 'desk', 'carteira (mesa + cadeira)', 'carteira', { seat: true, facing: 'board' }),
    tile('c', 'chair', 'cadeira', 'cadeira', { seat: true, facing: 'table' }),
    tile('t', 'table', 'mesa', 'mesa', { merge: true }),
    tile('s', 'shelf', 'estante', 'estante', { merge: true, facing: 'open_side' }),
    tile('k', 'locker', 'armário', 'armario', { facing: 'open_side' }),
    tile('p', 'plant', 'vaso de planta', 'planta'),
    tile('b', 'bed', 'cama', 'cama', { seat: true, merge: true, facing: 'open_side' }),
    tile('S', 'sofa', 'sofá', 'sofa', { seat: true, merge: true, facing: 'open_side' }),
    tile('C', 'counter', 'balcão', 'balcao', { merge: true, facing: 'open_side' }),
    tile('x', 'crate', 'caixa', 'caixa'),
  ].map((d) => [d.char, d]),
);

export const MAX_SIZE = 40;

export function legendSummary(): string {
  return Object.values(LEGEND)
    .map((d) => `'${d.char}' ${d.label}${d.seat ? ' (assento)' : ''}`)
    .join(', ');
}

export function isFixtureDef(d: TileDef): boolean {
  return d.kind !== 'wall' && d.kind !== 'floor' && d.kind !== 'void';
}

export function tileDef(loc: Pick<Location, 'tiles' | 'width' | 'height'>, x: number, y: number): TileDef {
  if (x < 0 || y < 0 || x >= loc.width || y >= loc.height) return LEGEND[' '];
  return LEGEND[loc.tiles[y][x]] ?? LEGEND[' '];
}

export function isPassable(loc: Location, x: number, y: number): boolean {
  return tileDef(loc, x, y).passable;
}

export function fixtureAt(loc: Location, x: number, y: number): Fixture | undefined {
  return loc.fixtures.find((f) => x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h);
}

export function rectCenter(r: { x: number; y: number; w: number; h: number }): Pos {
  return { x: r.x + (r.w - 1) / 2, y: r.y + (r.h - 1) / 2 };
}

export interface LocationSpec {
  id: string;
  name: string;
  description: string;
  layout: string | string[];
  floor?: FloorStyle;
  outdoor?: boolean;
  /** Luz ambiente de 0 (breu) a 1 (padrão). */
  light?: number;
}

export type LayoutResult =
  | { ok: true; location: Location; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** Limpa o que o modelo costuma mandar junto: cercas de código, indentação, espaços no fim. */
export function normalizeLayout(layout: string | string[]): { rows: string[]; warnings: string[] } {
  let rows = (Array.isArray(layout) ? layout.join('\n') : layout)
    .split('\n')
    .map((r) => r.replace(/\r$/, '').replace(/\t/g, '    '))
    .filter((r) => !/^\s*```/.test(r))
    .map((r) => r.replace(/\s+$/, ''));
  while (rows.length && rows[0] === '') rows.shift();
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  const indents = rows.filter((r) => r.trim() !== '').map((r) => r.length - r.trimStart().length);
  const cut = indents.length ? Math.min(...indents) : 0;
  rows = rows.map((r) => r.slice(cut));
  const width = Math.max(0, ...rows.map((r) => r.length));
  const warnings: string[] = [];
  const short = rows.map((r, y) => ({ y, len: r.length })).filter((r) => r.len < width);
  if (short.length) {
    const list = short.slice(0, 6).map((s) => `y${s.y} (${s.len})`).join(', ');
    warnings.push(`Linhas mais curtas que ${width} colunas foram completadas com vazio: ${list}.`);
  }
  return { rows: rows.map((r) => r.padEnd(width, ' ')), warnings };
}

interface Rect {
  def: TileDef;
  x: number;
  y: number;
  w: number;
  h: number;
}

const SIDES: Dir[] = ['S', 'N', 'E', 'W'];

/** Tiles encostados em um lado do retângulo. */
function sideTiles(r: { x: number; y: number; w: number; h: number }, side: Dir): Pos[] {
  const out: Pos[] = [];
  if (side === 'N' || side === 'S') {
    const y = side === 'N' ? r.y - 1 : r.y + r.h;
    for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
  } else {
    const x = side === 'W' ? r.x - 1 : r.x + r.w;
    for (let y = r.y; y < r.y + r.h; y++) out.push({ x, y });
  }
  return out;
}

function ringTiles(r: { x: number; y: number; w: number; h: number }): Pos[] {
  const out: Pos[] = [];
  for (let y = r.y - 1; y <= r.y + r.h; y++) {
    for (let x = r.x - 1; x <= r.x + r.w; x++) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
      out.push({ x, y });
    }
  }
  return out;
}

export function buildLocation(spec: LocationSpec): LayoutResult {
  const { rows, warnings } = normalizeLayout(spec.layout);
  const fail = (...errors: string[]): LayoutResult => ({ ok: false, errors, warnings });
  const h = rows.length;
  const w = h ? rows[0].length : 0;
  if (w < 3 || h < 3) return fail(`O layout precisa de pelo menos 3×3 tiles (recebido ${w}×${h}).`);
  if (w > MAX_SIZE || h > MAX_SIZE) return fail(`O layout pode ter no máximo ${MAX_SIZE}×${MAX_SIZE} tiles (recebido ${w}×${h}).`);

  const unknown = new Map<string, Pos>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!LEGEND[row[x]] && !unknown.has(row[x])) unknown.set(row[x], { x, y });
    }
  });
  if (unknown.size) {
    const list = [...unknown].map(([ch, p]) => `'${ch}' em (${p.x},${p.y})`).join(', ');
    return fail(`Caracteres fora da legenda: ${list}. Use apenas: ${legendSummary()}.`);
  }

  const grid = { tiles: rows, width: w, height: h };
  const def = (x: number, y: number) => tileDef(grid, x, y);
  const errors: string[] = [];

  // Regiões de chão (vizinhança 4, igual ao movimento sem cortar quinas).
  const comp = new Int32Array(w * h).fill(-1);
  const comps: Pos[][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!def(x, y).passable || comp[y * w + x] >= 0) continue;
      const tiles: Pos[] = [];
      const queue: Pos[] = [{ x, y }];
      comp[y * w + x] = comps.length;
      while (queue.length) {
        const p = queue.pop()!;
        tiles.push(p);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (def(nx, ny).passable && comp[ny * w + nx] < 0) {
            comp[ny * w + nx] = comps.length;
            queue.push({ x: nx, y: ny });
          }
        }
      }
      comps.push(tiles);
    }
  }
  if (!comps.length) errors.push(`Não há nenhum tile de chão ('.') ou porta ('D').`);
  if (comps.length > 1) {
    const sorted = [...comps].sort((a, b) => b.length - a.length);
    const isolated = sorted.slice(1, 4).map((c) => `(${c[0].x},${c[0].y})`).join(', ');
    errors.push(
      `O chão está dividido em ${comps.length} regiões desconectadas (a maior tem ${sorted[0].length} tiles). ` +
        `Tiles isolados, por exemplo: ${isolated}. Conecte as regiões com '.' ou 'D'.`,
    );
  }

  if (!spec.outdoor) {
    const leaks: string[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (def(x, y).kind !== 'floor') continue;
        const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        const nearVoid = [def(x + 1, y), def(x - 1, y), def(x, y + 1), def(x, y - 1)].some((d) => d.kind === 'void');
        if (onEdge || nearVoid) leaks.push(`(${x},${y})`);
      }
    }
    if (leaks.length) {
      const more = leaks.length > 8 ? ` e mais ${leaks.length - 8}` : '';
      errors.push(
        `O chão encosta no exterior sem parede em ${leaks.slice(0, 8).join(', ')}${more}. ` +
          `Feche com '#' (ou use outdoor=true para áreas abertas).`,
      );
    }
  }

  // Móveis: caracteres "merge" viram retângulos de vários tiles.
  const rects: Rect[] = [];
  const seen = new Uint8Array(w * h);
  const sameRun = (x0: number, x1: number, y: number, ch: string) => {
    for (let x = x0; x <= x1; x++) if (rows[y][x] !== ch || seen[y * w + x]) return false;
    return (x0 === 0 || rows[y][x0 - 1] !== ch) && (x1 === w - 1 || rows[y][x1 + 1] !== ch);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = def(x, y);
      if (!isFixtureDef(d) || seen[y * w + x]) continue;
      let x1 = x;
      if (d.merge) while (x1 + 1 < w && rows[y][x1 + 1] === d.char && !seen[y * w + x1 + 1]) x1++;
      let rh = 1;
      if (d.merge) while (y + rh < h && sameRun(x, x1, y + rh, d.char)) rh++;
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx <= x1; xx++) seen[yy * w + xx] = 1;
      rects.push({ def: d, x, y, w: x1 - x + 1, h: rh });
    }
  }

  const passableTiles = comps.flat();
  const roomCenter: Pos = passableTiles.length
    ? {
        x: passableTiles.reduce((s, p) => s + p.x, 0) / passableTiles.length,
        y: passableTiles.reduce((s, p) => s + p.y, 0) / passableTiles.length,
      }
    : { x: w / 2, y: h / 2 };
  const isInterior = (p: Pos) => {
    const d = def(p.x, p.y);
    return d.kind !== 'void' && !d.wall;
  };
  const bestSide = (r: Rect, test: (p: Pos) => boolean): Dir | null => {
    let best: Dir | null = null;
    let bestCount = 0;
    for (const side of SIDES) {
      const count = sideTiles(r, side).filter(test).length;
      if (count > bestCount) [best, bestCount] = [side, count];
    }
    return best;
  };

  // Primeiro o que fica na parede: carteiras e mesa do professor se orientam pelo quadro.
  const facingOf = new Map<Rect, Dir>();
  for (const r of rects) {
    if (r.def.facing !== 'interior') continue;
    const side = bestSide(r, isInterior);
    if (!side) errors.push(`${r.def.label} em (${r.x},${r.y}) não tem nenhum lado voltado para dentro da sala.`);
    facingOf.set(r, side ?? 'S');
  }
  const boards = rects.filter((r) => r.def.kind === 'board');
  const nearestBoard = (c: Pos) => {
    let best: Rect | null = null;
    for (const b of boards) {
      const bc = rectCenter(b);
      if (!best || Math.hypot(bc.x - c.x, bc.y - c.y) < Math.hypot(rectCenter(best).x - c.x, rectCenter(best).y - c.y)) best = b;
    }
    return best;
  };
  const tableLike = new Set<TileDef['kind']>(['table', 'teacher_desk', 'desk', 'counter']);
  for (const r of rects) {
    if (facingOf.has(r)) continue;
    const center = rectCenter(r);
    const board = nearestBoard(center);
    const towardBoard = board ? OPPOSITE[facingOf.get(board)!] : dirTowards(center, roomCenter);
    let facing: Dir = 'S';
    switch (r.def.facing) {
      case 'board':
        facing = towardBoard;
        break;
      case 'away_board':
        facing = board ? facingOf.get(board)! : dirTowards(center, roomCenter);
        break;
      case 'table':
        facing = bestSide(r, (p) => tableLike.has(def(p.x, p.y).kind)) ?? towardBoard;
        break;
      case 'open_side':
        facing = bestSide(r, (p) => def(p.x, p.y).passable) ?? 'S';
        break;
      default:
        break;
    }
    facingOf.set(r, facing);
  }

  const counters: Record<string, number> = {};
  const fixtures: Fixture[] = [];
  for (const r of rects) {
    const at = `${r.def.label} em (${r.x},${r.y})`;
    const facing = facingOf.get(r)!;
    if (!r.def.wall && !ringTiles(r).some((p) => def(p.x, p.y).passable)) {
      errors.push(`${at} está cercado(a) — deixe um corredor de chão ('.') encostado nele(a).`);
    }
    if (r.def.kind === 'door' && !SIDES.some((s) => sideTiles(r, s).some((p) => def(p.x, p.y).passable))) {
      errors.push(`${at} não dá para nenhum chão.`);
    }
    counters[r.def.slug] = (counters[r.def.slug] ?? 0) + 1;
    fixtures.push({
      id: `${spec.id}/${r.def.slug}-${counters[r.def.slug]}`,
      kind: r.def.kind as FixtureKind,
      label: r.def.label.replace(/ \(.*\)$/, ''),
      locationId: spec.id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      facing,
      seat: r.def.seat,
      wall: r.def.wall,
      text: '',
      state: '',
    });
  }

  if (!spec.outdoor && !fixtures.some((f) => f.kind === 'door')) {
    warnings.push(`Nenhuma porta ('D'): personagens não terão por onde entrar ou sair.`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  return {
    ok: true,
    warnings,
    location: {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      width: w,
      height: h,
      tiles: rows,
      fixtures,
      floor: spec.floor ?? (spec.outdoor ? 'grass' : 'wood'),
      outdoor: spec.outdoor ?? false,
      light: Math.round(Math.min(1, Math.max(0, spec.light ?? 1)) * 100) / 100,
    },
  };
}
