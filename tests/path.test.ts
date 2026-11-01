import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { isPassable } from '../src/engine/layout';
import { findPath } from '../src/engine/path';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';
import type { Location, Pos } from '../src/engine/types';

function classroom(): { e: GameEngine; loc: Location } {
  const e = GameEngine.create('Sala de aula.', 7);
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula.', layout: EXAMPLE_CLASSROOM });
  return { e, loc: e.state.locations.sala };
}

/** Cada passo vai a um vizinho, e o passo diagonal não corta quina (salvo entrando ou saindo de assento). */
function walkable(loc: Location, path: Pos[]): boolean {
  return path.slice(1).every((p, i) => {
    const q = path[i];
    const dx = p.x - q.x;
    const dy = p.y - q.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
    const seatStep = !isPassable(loc, q.x, q.y) || !isPassable(loc, p.x, p.y);
    return !dx || !dy || seatStep || (isPassable(loc, q.x + dx, q.y) && isPassable(loc, q.x, q.y + dy));
  });
}

describe('caminho no grid (A*)', () => {
  it('em campo aberto vai reto, sem zigue-zague', () => {
    const { loc } = classroom();
    const path = findPath(loc, { x: 1, y: 1 }, { x: 12, y: 1 })!;
    expect(path).toHaveLength(12);
    expect(path.every((p) => p.y === 1)).toBe(true);
  });

  it('contorna a mesa do professor sem cortar a quina dela', () => {
    const { loc } = classroom();
    const path = findPath(loc, { x: 6, y: 1 }, { x: 6, y: 3 })!;
    expect(path.some((p) => p.y === 2 && (p.x === 6 || p.x === 7))).toBe(false);
    expect(walkable(loc, path)).toBe(true);
    expect(path).toHaveLength(5);
  });

  it('termina no assento, que não é passável', () => {
    const { loc } = classroom();
    const path = findPath(loc, { x: 1, y: 5 }, { x: 2, y: 4 })!;
    expect(path.at(-1)).toEqual({ x: 2, y: 4 });
    expect(walkable(loc, path)).toBe(true);
  });

  it('desvia de quem está parado no caminho; sem outro jeito, passa pedindo licença', () => {
    const { loc } = classroom();
    const around = findPath(loc, { x: 1, y: 1 }, { x: 12, y: 1 }, (x, y) => x === 6 && y === 1)!;
    expect(around.some((p) => p.x === 6 && p.y === 1)).toBe(false);
    expect(walkable(loc, around)).toBe(true);
    expect(findPath(loc, { x: 1, y: 1 }, { x: 3, y: 1 }, () => true)).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ]);
  });

  it('move_character devolve o caminho que desvia de quem está no corredor', () => {
    const { e } = classroom();
    e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata', is_player: true, position: { x: 1, y: 1 } });
    e.createCharacter({ name: 'Ren Ito', role: 'aluno', appearance: 'boné', position: { x: 6, y: 1 } });
    const r = e.moveCharacter({ character_id: 'kenji', to: { x: 12, y: 1 } });
    expect(r.path!.some((p) => p.x === 6 && p.y === 1)).toBe(false);
    expect(e.state.characters.kenji.pos).toEqual({ x: 12, y: 1 });
  });
});
