import { isPassable } from './layout';
import type { Location, Pos } from './types';

/**
 * Caminho mais curto no grid de um local, por A*: o grid é um grafo em que cada tile liga com os
 * oito vizinhos, o passo reto custa 1 e o diagonal √2 (a rota sai reta, sem zigue-zague à toa), e
 * não se corta quina de parede ou móvel (salvo ao entrar ou sair de um assento, que não é passável).
 * O destino pode não ser passável (o assento). Os tiles de `blocked` (onde há gente parada) só
 * servem de destino; sem caminho desviando deles, passa por eles, como quem pede licença.
 * Roda no motor e no 3D, que anda por ele em vez de deslizar reto até o destino.
 */
export function findPath(loc: Location, from: Pos, to: Pos, blocked?: (x: number, y: number) => boolean): Pos[] | null {
  return search(loc, from, to, blocked) ?? (blocked ? search(loc, from, to) : null);
}

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

function search(loc: Location, from: Pos, to: Pos, blocked?: (x: number, y: number) => boolean): Pos[] | null {
  const W = loc.width;
  const H = loc.height;
  if (to.x < 0 || to.y < 0 || to.x >= W || to.y >= H) return null;
  const key = (x: number, y: number) => y * W + x;
  const start = key(from.x, from.y);
  const goal = key(to.x, to.y);
  // Distância octil: o menor custo possível até o destino, sem paredes no meio.
  const h = (x: number, y: number) => {
    const dx = Math.abs(x - to.x);
    const dy = Math.abs(y - to.y);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const cost = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>([[start, -1]]);
  const done = new Set<number>();
  const open = new Heap();
  open.push(start, h(from.x, from.y));
  while (open.size) {
    const cur = open.pop();
    if (cur === goal) {
      const path: Pos[] = [];
      for (let k = goal; k !== -1; k = prev.get(k)!) path.unshift({ x: k % W, y: Math.floor(k / W) });
      return path;
    }
    if (done.has(cur)) continue;
    done.add(cur);
    const cx = cur % W;
    const cy = Math.floor(cur / W);
    const curPassable = isPassable(loc, cx, cy);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const next = key(nx, ny);
      if (done.has(next)) continue;
      const nextPassable = isPassable(loc, nx, ny);
      if (next !== goal && (!nextPassable || blocked?.(nx, ny))) continue;
      const seatStep = !curPassable || !nextPassable;
      if (dx && dy && !seatStep && !(isPassable(loc, cx + dx, cy) && isPassable(loc, cx, cy + dy))) continue;
      const g = cost.get(cur)! + (dx && dy ? Math.SQRT2 : 1);
      if (g >= (cost.get(next) ?? Infinity)) continue;
      cost.set(next, g);
      prev.set(next, cur);
      open.push(next, g + h(nx, ny));
    }
  }
  return null;
}

/** Fila de prioridade (heap binário): sai sempre o nó de menor custo estimado. */
class Heap {
  private readonly nodes: number[] = [];
  private readonly scores: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, score: number): void {
    this.nodes.push(node);
    this.scores.push(score);
    let i = this.nodes.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.scores[parent] <= this.scores[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.nodes[0];
    const lastNode = this.nodes.pop()!;
    const lastScore = this.scores.pop()!;
    if (this.nodes.length) {
      this.nodes[0] = lastNode;
      this.scores[0] = lastScore;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let min = i;
        if (l < this.nodes.length && this.scores[l] < this.scores[min]) min = l;
        if (r < this.nodes.length && this.scores[r] < this.scores[min]) min = r;
        if (min === i) break;
        this.swap(i, min);
        i = min;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
    [this.scores[a], this.scores[b]] = [this.scores[b], this.scores[a]];
  }
}
