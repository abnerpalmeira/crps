import { describe, expect, it } from 'vitest';
import { arrange, type Rect } from '../src/client/arrange';

const inside = (outer: Rect, x: number, z: number, w: number, d: number) =>
  x - w / 2 >= outer.x0 - 1e-9 && x + w / 2 <= outer.x1 + 1e-9 && z - d / 2 >= outer.z0 - 1e-9 && z + d / 2 <= outer.z1 + 1e-9;
const hits = (r: Rect, x: number, z: number, w: number, d: number) => x + w / 2 > r.x0 + 1e-9 && x - w / 2 < r.x1 - 1e-9 && z + d / 2 > r.z0 + 1e-9 && z - d / 2 < r.z1 - 1e-9;

describe('itens numa superfície', () => {
  // Cama de 1 × 1,9 m, com alguém deitado ao comprido no meio.
  const bed: Rect = { x0: -0.49, z0: -0.45, x1: 0.49, z1: 1.45 };
  const body: Rect = { x0: -0.28, z0: bed.z0, x1: 0.28, z1: bed.z1 };

  it('o bilhete na cama de quem está deitado fica do lado do corpo, não embaixo da cabeça', () => {
    // Prefere o meio da cama, mas lá está o corpo: vai para a beira, perto da altura que queria.
    const spot = arrange(bed, [body], [{ id: 'bilhete', w: 0.21, d: 0.19, x: 0.05, z: 0.5 }]).get('bilhete')!;
    const [w, d] = spot.turned ? [0.19, 0.21] : [0.21, 0.19];
    expect(hits(body, spot.x, spot.z, w, d)).toBe(false);
    expect(inside(bed, spot.x, spot.z, w, d)).toBe(true);
    // Do lado mais perto de onde queria, e na mesma altura da cama (não no canto da cabeceira).
    expect(spot.x).toBeGreaterThan(0);
    expect(Math.abs(spot.z - 0.5)).toBeLessThan(0.05);
    // Girar um quarto de volta é o que faz caber sem encostar no corpo.
    expect(spot.turned).toBe(true);
  });

  it('dois itens não ocupam o mesmo lugar, e sem gente ficam onde queriam', () => {
    const table: Rect = { x0: -0.5, z0: -0.3, x1: 0.5, z1: 0.3 };
    const spots = arrange(table, [], [
      { id: 'copo', w: 0.12, d: 0.12, x: 0.1, z: 0 },
      { id: 'livro', w: 0.2, d: 0.15, x: 0.12, z: 0.02 },
    ]);
    const copo = spots.get('copo')!;
    const livro = spots.get('livro')!;
    expect(Math.hypot(copo.x - 0.1, copo.z)).toBeLessThan(0.03);
    const [lw, ld] = livro.turned ? [0.15, 0.2] : [0.2, 0.15];
    expect(hits({ x0: copo.x - 0.06, z0: copo.z - 0.06, x1: copo.x + 0.06, z1: copo.z + 0.06 }, livro.x, livro.z, lw, ld)).toBe(false);
  });

  it('sem lugar livre, fica onde cobre menos, sem sair da superfície', () => {
    // Uma placa maior que a beira livre da cama: encosta no corpo o mínimo possível.
    const spot = arrange(bed, [body], [{ id: 'placa', w: 0.5, d: 0.5, x: 0, z: 0.5 }]).get('placa')!;
    expect(inside(bed, spot.x, spot.z, 0.5, 0.5)).toBe(true);
    expect(Math.abs(spot.x)).toBeCloseTo(0.49 - 0.25, 1);
  });

  it('no chão, o item sai de baixo de quem está de pé no tile', () => {
    const tile: Rect = { x0: 2.55, z0: 3.55, x1: 3.45, z1: 4.45 };
    const person: Rect = { x0: 2.75, z0: 3.75, x1: 3.25, z1: 4.25 };
    const spot = arrange(tile, [person], [{ id: 'chave', w: 0.12, d: 0.06, x: 3, z: 4 }]).get('chave')!;
    const [w, d] = spot.turned ? [0.06, 0.12] : [0.12, 0.06];
    expect(hits(person, spot.x, spot.z, w, d)).toBe(false);
    expect(inside(tile, spot.x, spot.z, w, d)).toBe(true);
  });
});
