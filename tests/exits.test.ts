import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { buildLocation } from '../src/engine/layout';
import { buildTemplate } from '../src/engine/templates';
import { runTool } from '../src/engine/tools';

function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Saguão (com rua) e corredor do 11º andar, um entregador entrando pela rua. */
function building(): GameEngine {
  const e = GameEngine.create('teste', 3);
  e.createLocation({ id: 'saguao', name: 'Saguão', description: '', template: { name: 'saguao' } });
  e.createLocation({ id: 'andar_11', name: 'Corredor do 11º andar', description: '', template: { name: 'corredor', floor: 11 } });
  e.createLocation({ id: 'rua', name: 'Rua Augusta', description: '', layout: ['...........', '....D......', '...........'], outdoor: true });
  e.createCharacter({ name: 'Rafa Lima', role: 'entregador', appearance: '', is_player: true, location_id: 'saguao' });
  e.createCharacter({ name: 'Valdir', role: 'porteiro', appearance: '', location_id: 'saguao', position: { seat: 'saguao/cadeira-1' } });
  return e;
}

describe('layouts prontos', () => {
  it('saguão e corredor sempre passam nas regras do motor, nas duas orientações', () => {
    for (let seed = 1; seed <= 20; seed++) {
      for (const [name, opts] of [['saguao', { width: 14 + (seed % 9) }], ['corredor', { floor: seed, width: 12 + seed }]] as const) {
        const t = buildTemplate(name, opts, seeded(seed));
        const r = buildLocation({ id: 'x', name: 'x', description: '', layout: t.rows });
        expect(r.ok ? r.warnings : r.errors, `${name} ${seed}`).toEqual([]);
      }
    }
  });

  it('a portaria fica junto da entrada e o porteiro olha para ela', () => {
    const e = building();
    const lobby = e.state.locations.saguao;
    const door = lobby.fixtures.find((f) => f.kind === 'door')!;
    const counter = lobby.fixtures.find((f) => f.kind === 'counter')!;
    const chair = lobby.fixtures.find((f) => f.kind === 'chair')!;
    expect(lobby.height - 1 - counter.y).toBeLessThanOrEqual(3);
    expect(Math.abs(counter.y - door.y)).toBeLessThanOrEqual(3);
    expect(chair.facing).toBe('S');
    expect(lobby.fixtures.filter((f) => f.kind === 'elevator')).toHaveLength(2);
    expect(Object.values(lobby.exits).map((x) => x.label).sort()).toEqual(['Elevador A', 'Elevador B', 'Escada', 'Saída para a rua']);
  });

  it('o corredor numera os apartamentos pelo andar', () => {
    const labels = Object.values(building().state.locations.andar_11.exits).map((x) => x.label);
    expect(labels).toEqual(expect.arrayContaining(['Elevador', 'Escada', 'Apto 1101', 'Apto 1106']));
  });
});

describe('saídas', () => {
  it('mudar de local passa por uma saída; sem dizer qual, o motor pergunta', () => {
    const e = building();
    const r = runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'andar_11' } });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/^Por onde ele sai de Saguão\? Informe via com uma das saídas: /);
    expect(r.content).toContain('porta-1 (Saída para a rua)');
    expect(r.content).toContain('elevador-1 (Elevador A)');
  });

  it('o elevador liga os dois lados, e a volta usa o mesmo caminho', () => {
    const e = building();
    const up = runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'andar_11' }, via: 'elevador-1' });
    expect(up.ok).toBe(true);
    expect(up.data).toMatchObject({ via: 'saguao/elevador-1', arrived_by: 'andar_11/elevador-1' });
    expect(e.state.locations.saguao.exits['saguao/elevador-1'].to).toEqual(['andar_11']);
    expect(e.state.locations.andar_11.exits['andar_11/elevador-1'].to).toEqual(['saguao']);
    const down = runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'saguao' } });
    expect(down.data).toMatchObject({ via: 'andar_11/elevador-1', arrived_by: 'saguao/elevador-1' });
  });

  it('o mesmo elevador leva a qualquer andar, e quem sobe de escada chega pela escada', () => {
    const e = building();
    e.createLocation({ id: 'andar_5', name: 'Corredor do 5º andar', description: '', template: { name: 'corredor', floor: 5 } });
    const move = (to: string, via?: string) => runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: to }, ...(via ? { via } : {}) });
    expect(move('andar_11', 'elevador-1').ok).toBe(true);
    // Do 11º direto para o 5º, pelo elevador que já levava ao saguão.
    const down = move('andar_5', 'elevador-1');
    expect(down.ok, down.content).toBe(true);
    expect(down.data).toMatchObject({ via: 'andar_11/elevador-1', arrived_by: 'andar_5/elevador-1' });
    expect(e.state.locations.andar_11.exits['andar_11/elevador-1'].to).toEqual(['saguao', 'andar_5']);
    expect(move('saguao', 'escada-1').data).toMatchObject({ arrived_by: 'saguao/escada-1' });
    expect(move('andar_11', 'elevador-1').ok).toBe(true);
    expect(e.state.locations.saguao.exits['saguao/elevador-1'].to).toEqual(['andar_11']);
    expect(compileBrief(e)).toContain('elevador-1 (Elevador, → Saguão [saguao], Corredor do 5º andar [andar_5])');
  });

  it('save antigo, com um destino só por saída, vira lista', () => {
    const e = building();
    const raw = JSON.parse(e.toJSON());
    raw.locations.saguao.exits['saguao/porta-1'].to = 'rua';
    raw.locations.saguao.exits['saguao/elevador-1'].to = null;
    const loaded = GameEngine.fromJSON(JSON.stringify(raw));
    expect(loaded.state.locations.saguao.exits['saguao/porta-1'].to).toEqual(['rua']);
    expect(loaded.state.locations.saguao.exits['saguao/elevador-1'].to).toEqual([]);
  });

  it('uma saída que já leva a outro lugar não serve de atalho', () => {
    const e = building();
    runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'rua' }, via: 'porta-1' });
    runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'saguao' } });
    const wrong = runTool(e, 'move_character', { character_id: 'rafa', to: { location_id: 'andar_11' }, via: 'porta-1' });
    expect(wrong.content).toBe('porta-1 leva a Rua Augusta, não a Corredor do 11º andar.');
  });

  it('o resumo lista as saídas do local para o mestre', () => {
    const brief = compileBrief(building());
    expect(brief).toMatch(/Saídas: .*porta-1 \(Saída para a rua, sem destino ainda\)/);
    expect(brief).toContain('elevador-2 (Elevador B, sem destino ainda)');
  });
});
