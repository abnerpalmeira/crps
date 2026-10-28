import { describe, expect, it } from 'vitest';
import { buildLocation, normalizeLayout } from '../src/engine/layout';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';

const spec = (layout: string | string[], extra: { outdoor?: boolean } = {}) => ({
  id: 'sala',
  name: 'Sala',
  description: '',
  layout,
  ...extra,
});

describe('buildLocation', () => {
  it('monta a sala de aula de exemplo com móveis orientados pelo quadro', () => {
    const result = buildLocation(spec(EXAMPLE_CLASSROOM));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { location } = result;
    expect(location.width).toBe(14);
    expect(location.height).toBe(11);

    const byKind = (kind: string) => location.fixtures.filter((f) => f.kind === kind);
    const [board] = byKind('board');
    expect(board).toMatchObject({ id: 'sala/quadro-1', x: 5, y: 0, w: 4, h: 1, facing: 'S' });
    expect(byKind('teacher_desk')[0]).toMatchObject({ id: 'sala/mesa-prof-1', x: 6, y: 2, w: 2, facing: 'S' });
    expect(byKind('desk')).toHaveLength(15);
    expect(byKind('desk').every((d) => d.facing === 'N' && d.seat)).toBe(true);
    expect(byKind('window').map((w) => w.facing)).toEqual(['E', 'E', 'E']);
    expect(byKind('door')[0]).toMatchObject({ id: 'sala/porta-1', x: 13, y: 5, facing: 'W' });
    expect(result.warnings).toEqual([]);
  });

  it('recusa caracteres fora da legenda', () => {
    const result = buildLocation(spec(['#####', '#.?.#', '#####']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/'\?' em \(2,1\)/);
  });

  it('acusa chão aberto para o exterior', () => {
    const result = buildLocation(spec(['#####', '#...#', '#....', '#####']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/exterior sem parede em \(4,2\)/);
  });

  it('aceita área aberta sem paredes quando outdoor=true', () => {
    const result = buildLocation(spec(['.....', '..p..', '.....'], { outdoor: true }));
    expect(result.ok).toBe(true);
  });

  it('acusa regiões desconectadas', () => {
    const result = buildLocation(spec(['#######', '#..#..#', '#######']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toMatch(/2 regiões desconectadas/);
  });

  it('acusa móvel cercado sem corredor', () => {
    const result = buildLocation(spec(['#######', '#.....#', '#.ddd.#', '#.ddd.#', '#.ddd.#', '#.....D', '#######']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/\(3,3\).*cercad/);
    }
  });

  it('limpa cercas de código, indentação e linhas curtas', () => {
    const { rows, warnings } = normalizeLayout('```\n    ####\n    #..#\n    #.\n    ####\n```');
    expect(rows).toEqual(['####', '#..#', '#.  ', '####']);
    expect(warnings[0]).toMatch(/y2 \(2\)/);
  });
});
