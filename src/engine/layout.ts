import { OBJECT_LIBRARY } from './objects';
import { OPPOSITE, dirTowards, slugify } from './text';
import type { Dir, Exit, Fixture, FloorStyle, Location, ObjectType, Pos, TileDef } from './types';

export type { TileDef };

/** O tile de um tipo de objeto sob um caractere da legenda. */
export function tileOf(t: ObjectType, char: string): TileDef {
  return {
    char,
    kind: t.id,
    label: t.label,
    slug: t.slug ?? slugify(t.label).replace(/_/g, '-'),
    passable: t.passable ?? false,
    wall: t.wall ?? false,
    seat: t.seat ?? false,
    merge: t.merge ?? false,
    facing: t.facing ?? 'none',
    ...(t.table ? { table: true } : {}),
    ...(t.exit ? { exit: t.exit } : {}),
    ...(t.size ? { size: t.size } : {}),
  };
}

const BASE: TileDef[] = [
  { char: '#', kind: 'wall', label: 'parede', slug: 'parede', passable: false, wall: true, seat: false, merge: false, facing: 'none' },
  { char: '.', kind: 'floor', label: 'chão', slug: 'chao', passable: true, wall: false, seat: false, merge: false, facing: 'none' },
  { char: ' ', kind: 'void', label: 'vazio/exterior', slug: 'vazio', passable: false, wall: false, seat: false, merge: false, facing: 'none' },
];

/** A legenda fixa: parede, chão, vazio e os objetos de sempre, cada um com seu caractere. */
export const LEGEND: Record<string, TileDef> = Object.fromEntries(
  [...BASE, ...Object.values(OBJECT_LIBRARY).flatMap((t) => (t.char ? [tileOf(t, t.char)] : []))].map((d) => [d.char, d]),
);

export const MAX_SIZE = 40;

const EXIT_LABEL: Record<string, string> = { door: 'saída', elevator: 'elevador', stairs: 'escada' };

/** Toda porta, elevador e escada (ou outra saída, como uma escotilha) começa sem destino. */
export function defaultExits(fixtures: Fixture[]): Record<string, Exit> {
  return Object.fromEntries(fixtures.filter((f) => f.exit).map((f) => [f.id, { to: [], label: EXIT_LABEL[f.kind] ?? f.label }]));
}

export function legendSummary(): string {
  return Object.values(LEGEND)
    .map((d) => {
      const notes = [d.seat && 'assento', d.size].filter(Boolean).join(', ');
      return `'${d.char}' ${d.label}${notes ? ` (${notes})` : ''}`;
    })
    .join(', ');
}

/**
 * Objeto comprido (cama, carro, cápsula) num espaço menor que o tamanho típico: o modelo do 3D
 * encolheria até virar miniatura. Devolve o erro com o desenho certo, ou null se cabe.
 */
function tooSmall(r: { x: number; y: number; w: number; h: number; def: TileDef }): string | null {
  const m = r.def.facing === 'lengthwise' ? /^(\d+)\s*[×x]\s*(\d+)$/.exec(r.def.size ?? '') : null;
  if (!m) return null;
  const [short, long] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
  if (Math.min(r.w, r.h) >= short && Math.max(r.w, r.h) >= long) return null;
  const c = r.def.char;
  const draw =
    short === 1
      ? `desenhe ${c.repeat(long)} numa linha ou '${c}' em ${long} linhas seguidas`
      : `desenhe um bloco de ${short} linhas de ${c.repeat(long)} (ou ${long} linhas de ${c.repeat(short)})`;
  return `${r.def.label} ('${c}') em (${r.x},${r.y}) ocupa ${r.w}×${r.h} tiles e precisa de ${short}×${long}, senão vira miniatura: ${draw}.`;
}

export function isFixtureDef(d: TileDef): boolean {
  return d.kind !== 'wall' && d.kind !== 'floor' && d.kind !== 'void';
}

export function tileDef(loc: Pick<Location, 'tiles' | 'width' | 'height' | 'legend'>, x: number, y: number): TileDef {
  if (x < 0 || y < 0 || x >= loc.width || y >= loc.height) return LEGEND[' '];
  const ch = loc.tiles[y][x];
  return LEGEND[ch] ?? loc.legend?.[ch] ?? LEGEND[' '];
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
  /** Caracteres extras deste local, cada um com o tile de um tipo de objeto. */
  legend?: Record<string, TileDef>;
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

  const legend = spec.legend ?? {};
  const unknown = new Map<string, Pos>();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (!LEGEND[row[x]] && !legend[row[x]] && !unknown.has(row[x])) unknown.set(row[x], { x, y });
    }
  });
  if (unknown.size) {
    const list = [...unknown].map(([ch, p]) => `'${ch}' em (${p.x},${p.y})`).join(', ');
    const extra = Object.values(legend).map((d) => `'${d.char}' ${d.label}`);
    return fail(
      `Caracteres fora da legenda: ${list}. Use apenas: ${legendSummary()}${extra.length ? `, ${extra.join(', ')}` : ''}; ` +
        'outros objetos entram pela legenda do local (legend).',
    );
  }

  const grid = { tiles: rows, width: w, height: h, legend };
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
        facing = bestSide(r, (p) => Boolean(def(p.x, p.y).table)) ?? towardBoard;
        break;
      case 'open_side':
        facing = bestSide(r, (p) => def(p.x, p.y).passable) ?? 'S';
        break;
      case 'lengthwise': {
        // Ao longo do lado maior (cama, carro), com a frente para a ponta mais livre.
        const ends: Dir[] = r.h > r.w ? ['S', 'N'] : r.w > r.h ? ['E', 'W'] : SIDES;
        const open = (s: Dir) => sideTiles(r, s).filter((p) => def(p.x, p.y).passable).length;
        facing = ends.reduce((best, s) => (open(s) > open(best) ? s : best));
        break;
      }
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
    if (r.def.exit && !SIDES.some((s) => sideTiles(r, s).some((p) => def(p.x, p.y).passable))) {
      errors.push(`${at} não dá para nenhum chão.`);
    }
    const small = tooSmall(r);
    if (small) errors.push(small);
    counters[r.def.slug] = (counters[r.def.slug] ?? 0) + 1;
    fixtures.push({
      id: `${spec.id}/${r.def.slug}-${counters[r.def.slug]}`,
      kind: r.def.kind,
      label: r.def.label.replace(/ \(.*\)$/, ''),
      locationId: spec.id,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      facing,
      seat: r.def.seat,
      wall: r.def.wall,
      ...(r.def.exit ? { exit: r.def.exit } : {}),
      text: '',
      state: '',
    });
  }

  const exits = fixtures.filter((f) => f.exit);
  if (!spec.outdoor && !exits.length) {
    warnings.push(`Nenhuma porta ('D'), elevador ('E') ou escada ('Z'): personagens não terão por onde entrar ou sair.`);
  }
  // Comprido e estreito por dentro, como um corredor, com uma saída só: um beco sem saída.
  const [inner, across] = [Math.max(w, h) - 2, Math.min(w, h) - 2];
  if (!spec.outdoor && exits.length === 1 && inner >= 3 * across) {
    warnings.push(
      `Comprido e estreito como um corredor, com uma saída só (${exits[0].id.split('/').pop()}): quem entrar só volta por ela. ` +
        'Se esse lugar tem de verdade outras saídas, desenhe-as (podem levar a lugares que ainda não existem); se é mesmo um beco, deixe assim.',
    );
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
      exits: defaultExits(fixtures),
      ...(Object.keys(legend).length ? { legend } : {}),
    },
  };
}
