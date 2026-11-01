import { locationLook } from '../engine/eras';
import { fixtureAt, tileDef } from '../engine/layout';
import { typeChain } from '../engine/objects';
import type { Location, WorldState } from '../engine/types';

/** Um ponto de parede para pendurar decoração: o tile da parede, para que lado fica o cômodo e o quê. */
export interface DecorSpot {
  x: number;
  y: number;
  dx: number;
  dy: number;
  kind: string;
}

/** Móvel que encosta na parede e cobriria a decoração: estante, armário, lareira, geladeira. */
function tall(world: Pick<WorldState, 'objectTypes'>, kind: string): boolean {
  const chain = typeChain(world, kind);
  const height = chain.map((t) => t.height ?? t.surface).find((v) => v !== undefined) ?? 0;
  return height >= 1.2 || chain.some((t) => t.id === 'shelf');
}

/**
 * Onde pendurar a decoração do lugar: um a cada três tiles de parede reta (cantos, portas e janelas
 * ficam de fora), pulando a parede atrás de móvel alto. As decorações se revezam pela ordem dos
 * pontos, então a sala fica com um pouco de cada.
 */
export function decorSpots(world: Pick<WorldState, 'objectTypes'>, loc: Location): DecorSpot[] {
  const kinds = locationLook(loc).decor;
  if (!kinds.length) return [];
  const inside = (x: number, y: number) => {
    const d = tileDef(loc, x, y);
    return d.kind !== 'void' && !d.wall;
  };
  const spots: DecorSpot[] = [];
  for (let y = 0; y < loc.height; y++) {
    for (let x = 0; x < loc.width; x++) {
      if (tileDef(loc, x, y).kind !== 'wall' || (x + y) % 3 !== 0) continue;
      const open = ([[0, 1], [0, -1], [1, 0], [-1, 0]] as const).filter(([dx, dy]) => inside(x + dx, y + dy));
      // Só parede reta, com o cômodo de um lado: canto e divisória entre dois cômodos ficam lisos.
      if (open.length !== 1) continue;
      const [dx, dy] = open[0];
      const front = fixtureAt(loc, x + dx, y + dy);
      if (front && tall(world, front.kind)) continue;
      spots.push({ x, y, dx, dy, kind: kinds[spots.length % kinds.length] });
    }
  }
  return spots;
}
