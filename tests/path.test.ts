import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { isPassable } from '../src/engine/layout';
import { besideRect, findPath, walkGoal } from '../src/engine/path';
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

describe('aonde vai quem anda (o mesmo no motor e no caminho que o 3D desenha)', () => {
  /** Quem está em cada tile, como o 3D monta a partir do mundo. */
  const people = (spots: Record<string, string>) => (x: number, y: number) => spots[`${x},${y}`] ?? null;

  it('o tile clicado, se dá para ficar nele; senão, o livre mais perto', () => {
    const { loc } = classroom();
    const occupant = people({ '1,1': 'kenji', '3,3': 'ren' });
    expect(walkGoal(loc, { x: 9, y: 3 }, occupant, 'kenji')).toEqual({ x: 9, y: 3 });
    // O próprio tile de quem anda serve de destino; o de outra pessoa, não.
    expect(walkGoal(loc, { x: 1, y: 1 }, occupant, 'kenji')).toEqual({ x: 1, y: 1 });
    const beside = walkGoal(loc, { x: 3, y: 3 }, occupant, 'kenji')!;
    expect(beside).not.toEqual({ x: 3, y: 3 });
    expect(Math.max(Math.abs(beside.x - 3), Math.abs(beside.y - 3))).toBe(1);
    // A mesa do professor não é chão: vai para o lado dela.
    const desk = walkGoal(loc, { x: 6, y: 2 }, occupant, 'kenji')!;
    expect(isPassable(loc, desk.x, desk.y)).toBe(true);
    expect(Math.max(Math.abs(desk.x - 6), Math.abs(desk.y - 2))).toBe(1);
  });

  it('ao lado de um móvel ou pessoa, o tile livre de caminho mais curto', () => {
    const { e, loc } = classroom();
    const desk = loc.fixtures.find((f) => f.label === 'mesa do professor')!;
    const blocked = (x: number, y: number) => x === 6 && y === 3;
    // Vindo de baixo, para no lado de baixo da mesa, e não onde há alguém.
    const p = besideRect(loc, desk, { x: 6, y: 7 }, blocked)!;
    expect(p.y).toBe(3);
    expect(p).not.toEqual({ x: 6, y: 3 });
    // O motor escolhe o mesmo lugar ao andar até a mesa.
    e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata', is_player: true, position: { x: 6, y: 7 } });
    e.createCharacter({ name: 'Ren Ito', role: 'aluno', appearance: 'boné', position: { x: 6, y: 3 } });
    e.moveCharacter({ character_id: 'kenji', to: { near: desk.id } });
    expect(e.state.characters.kenji.pos).toEqual(p);
  });
});
