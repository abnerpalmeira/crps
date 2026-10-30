/**
 * Onde cada item fica numa superfície (o tampo de um móvel, um tile do chão): dois corpos não
 * ocupam o mesmo lugar. Cada item procura o ponto livre mais perto do seu (o do sorteio pelo id),
 * sem cair em cima de quem está ali (deitado na cama, sentado na cadeira) nem de outro item; sem
 * lugar livre, fica onde cobre menos.
 */

/** Retângulo no plano do chão, em metros. */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export interface Spot {
  id: string;
  /** Largura (x) e profundidade (z) do item. */
  w: number;
  d: number;
  /** Onde ele preferia ficar. */
  x: number;
  z: number;
}

const STEP = 0.04;
/** Folga entre dois itens, e entre um item e um corpo. */
const GAP = 0.02;

function overlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0));
}

/** Onde o centro de uma coisa de tamanho `size` pode ficar entre `lo` e `hi` sem passar da borda. */
function steps(lo: number, hi: number, size: number): number[] {
  const a = lo + size / 2;
  const b = hi - size / 2;
  if (a >= b) return [(lo + hi) / 2];
  // Passo que chega exatamente às duas bordas: os dois lados de uma cama valem o mesmo.
  const n = Math.ceil((b - a) / STEP);
  return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
}

/**
 * Escolhe, nessa ordem: o lugar com folga de tudo; o que só encosta; o que cobre menos. Entre
 * lugares iguais, o mais perto do preferido. O item pode girar um quarto de volta para caber.
 */
export function arrange(area: Rect, blocked: Rect[], items: Spot[]): Map<string, { x: number; z: number; turned: boolean }> {
  const spots = new Map<string, { x: number; z: number; turned: boolean }>();
  const taken = [...blocked];
  const cover = (r: Rect) => taken.reduce((sum, t) => sum + overlap(r, t), 0);
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    let best = { x: item.x, z: item.z, turned: false, w: item.w, d: item.d, rank: Infinity, hard: Infinity, far: Infinity };
    for (const turned of item.w === item.d ? [false] : [false, true]) {
      const [w, d] = turned ? [item.d, item.w] : [item.w, item.d];
      for (const x of steps(area.x0, area.x1, w)) {
        for (const z of steps(area.z0, area.z1, d)) {
          const hard = cover({ x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2 });
          const soft = hard > 1e-9 ? hard : cover({ x0: x - w / 2 - GAP, z0: z - d / 2 - GAP, x1: x + w / 2 + GAP, z1: z + d / 2 + GAP });
          const rank = soft <= 1e-9 ? 0 : hard <= 1e-9 ? 1 : 2;
          const far = (x - item.x) ** 2 + (z - item.z) ** 2;
          const better =
            rank !== best.rank ? rank < best.rank : rank === 2 && Math.abs(hard - best.hard) > 1e-6 ? hard < best.hard : far < best.far - 1e-9;
          if (better) best = { x, z, turned, w, d, rank, hard, far };
        }
      }
    }
    spots.set(item.id, { x: best.x, z: best.z, turned: best.turned });
    taken.push({ x0: best.x - best.w / 2, z0: best.z - best.d / 2, x1: best.x + best.w / 2, z1: best.z + best.d / 2 });
  }
  return spots;
}
