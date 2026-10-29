import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { sceneAt, snapshotScene } from '../src/engine/frames';
import { lightAt, lightSources } from '../src/engine/light';
import { perceivesSpeech, sightOf, visionOf } from '../src/engine/perception';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';

/** Professor (jogador) em (6,1); Haruto (2,4) e Yuki (4,4) lado a lado; Mei no fundo, em (10,8). */
function room(light = 1): GameEngine {
  const e = GameEngine.create('teste', 3);
  e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM, light });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { x: 6, y: 1 } });
  e.createCharacter({ name: 'Haruto Mori', role: 'aluno', appearance: '', position: { seat: 'sala/carteira-1' } });
  e.createCharacter({ name: 'Yuki Sato', role: 'aluna', appearance: '', position: { seat: 'sala/carteira-2' } });
  e.createCharacter({ name: 'Mei Kato', role: 'aluna', appearance: '', position: { seat: 'sala/carteira-15' } });
  return e;
}

function lantern(e: GameEngine, on = true) {
  e.createItem({ id: 'lanterna', name: 'Lanterna', description: '', holder: { character_id: 'kenji' }, light: { radius: 5, on } });
}

describe('luz', () => {
  it('a luz de cada tile vem do ambiente ou da lanterna mais próxima', () => {
    const e = room(0.05);
    expect(lightAt(e.state, 'sala', { x: 10, y: 8 })).toBe(0.05);
    lantern(e);
    expect(lightSources(e.state, 'sala')).toMatchObject([{ id: 'lanterna', carrierId: 'kenji', pos: { x: 6, y: 1 } }]);
    expect(lightAt(e.state, 'sala', { x: 6, y: 1 })).toBe(0.9);
    expect(lightAt(e.state, 'sala', { x: 6, y: 4 })).toBeCloseTo(0.675, 1);
    expect(lightAt(e.state, 'sala', { x: 10, y: 8 })).toBe(0.05);
    expect(runTool(e, 'update_item', { item_id: 'lanterna', light_on: false }).summary).toBe('🔦 Lanterna: luz apagada');
    expect(lightAt(e.state, 'sala', { x: 6, y: 1 })).toBe(0.05);
  });

  it('update_location muda a luz ambiente; item sem luz não acende', () => {
    const e = room();
    const r = runTool(e, 'update_location', { location_id: 'sala', light: 0.1, reason: 'queda de energia' });
    expect(r.summary).toBe('🌑 Sala: luz claro → escuro');
    expect(e.state.locations.sala.light).toBe(0.1);
    e.createItem({ id: 'giz', name: 'Giz', description: '', holder: { character_id: 'kenji' } });
    expect(runTool(e, 'update_item', { item_id: 'giz', light_on: true }).content).toMatch(/Giz não ilumina/);
  });
});

describe('visão', () => {
  it('nítido no claro, nada no escuro, e vulto na beira da lanterna', () => {
    expect(sightOf(room().state, 'kenji', 'mei')).toBe('nitido');
    const e = room(0.05);
    expect(sightOf(e.state, 'kenji', 'yuki')).toBe('nada');
    lantern(e);
    expect(sightOf(e.state, 'kenji', 'yuki')).toBe('nitido');
    expect(sightOf(e.state, 'kenji', 'haruto')).toBe('vulto');
    expect(sightOf(e.state, 'kenji', 'mei')).toBe('nada');
    // Quem carrega a luz é visto de longe.
    expect(sightOf(e.state, 'mei', 'kenji')).toBe('nitido');
  });

  it('cegueira apaga tudo e passa com o tempo; visão turva vê de perto e só vultos de longe', () => {
    const e = room();
    expect(runTool(e, 'update_character', { character_id: 'kenji', conditions_add: [{ id: 'cego', minutes: 15 }] }).summary).toBe(
      '✏️ Kenji Tanaka: condições: Cego (até 08:15)',
    );
    expect(visionOf(e.state, 'kenji').acuity).toBe(0);
    expect(sightOf(e.state, 'kenji', 'yuki')).toBe('nada');
    expect(runTool(e, 'advance_time', { minutes: 20, reason: 'aula' }).summary).toContain('Kenji Tanaka: Cego passou');
    expect(e.state.characters.kenji.conditions).toEqual([]);
    e.updateCharacter({ character_id: 'kenji', conditions_add: ['visao_turva'] });
    expect(sightOf(e.state, 'kenji', 'yuki')).toBe('nitido');
    expect(sightOf(e.state, 'kenji', 'mei')).toBe('vulto');
    expect(() => e.updateCharacter({ character_id: 'kenji', conditions_add: ['petrificado'] })).toThrow(
      /Condição "petrificado" não existe.*cego, visao_turva, ofuscado, surdo/,
    );
  });

  it('perks: visão no escuro e poder de luz', () => {
    const e = room(0);
    e.extendRuleset({
      reason: 'poderes',
      perks: [
        { name: 'Visão no escuro', description: '', grants: [{ kind: 'sense', channel: 'visao', bonus: 4 }] },
        { name: 'Aura de luz', description: '', grants: [{ kind: 'light', radius: 4 }] },
      ],
    });
    e.updateCharacter({ character_id: 'kenji', perks_add: ['visao_no_escuro'] });
    expect(sightOf(e.state, 'kenji', 'haruto')).toBe('nitido');
    expect(sightOf(e.state, 'kenji', 'mei')).toBe('nada');
    e.updateCharacter({ character_id: 'mei', perks_add: ['aura_de_luz'] });
    expect(lightSources(e.state, 'sala')).toMatchObject([{ kind: 'character', carrierId: 'mei', radius: 4 }]);
    expect(sightOf(e.state, 'kenji', 'mei')).toBe('nitido');
  });

  it('ler lábios exige enxergar quem fala', () => {
    const e = room();
    e.extendRuleset({ reason: 'traço', perks: [{ name: 'Leitura labial', description: '', grants: [{ kind: 'sense', channel: 'labios', multiplier: 2 }] }] });
    e.updateCharacter({ character_id: 'kenji', perks_add: ['leitura_labial'] });
    const whisper = e.state.ruleset.speech.cochicho;
    expect(perceivesSpeech(e.state, 'kenji', 'haruto', whisper)).toBe(true);
    e.updateLocation({ location_id: 'sala', light: 0.05 });
    expect(perceivesSpeech(e.state, 'kenji', 'haruto', whisper)).toBe(false);
  });

  it('agir contra quem não se vê custa caro, salvo o que não depende de ver', () => {
    const e = room(0.05);
    const thrown = e.skillCheck({ character_id: 'haruto', attribute: 'corpo', difficulty: 'normal', reason: 'jogar borracha', target_id: 'yuki', reach: 'arremesso' });
    expect(thrown.against?.sight).toBe('nada');
    expect(thrown.sight_penalty).toBe(3);
    const mind = e.skillCheck({ character_id: 'haruto', attribute: 'mente', difficulty: 'normal', reason: 'telepatia', target_id: 'yuki', needs_sight: false });
    expect(mind.sight_penalty).toBe(0);
  });
});

describe('mestre, saves e replay', () => {
  it('o resumo diz ao mestre a luz, as condições e quem o jogador não vê', () => {
    const e = room(0.05);
    lantern(e);
    e.updateCharacter({ character_id: 'kenji', conditions_add: ['visao_turva'] });
    const brief = compileBrief(e);
    expect(brief).toContain('Luz: escuro (ambiente 0.05); acesas: Lanterna [lanterna] com Kenji Tanaka (raio 5).');
    expect(brief).toMatch(/Mei Kato \[mei\].*; luz: escuro; o jogador NÃO vê/);
    expect(brief).toContain('Visão: turva (acuidade 0.5); luz onde está: claro. Condições: Visão turva.');
  });

  it('saves antigos ganham luz, visão e condições padrão', () => {
    const old = JSON.parse(room().toJSON());
    delete old.locations.sala.light;
    delete old.ruleset.conditions;
    delete old.ruleset.vision;
    delete old.ruleset.sightChannels;
    delete old.ruleset.senses.visao;
    for (const c of Object.values(old.characters)) delete (c as { conditions?: unknown }).conditions;
    const back = GameEngine.fromJSON(JSON.stringify(old));
    expect(back.state.locations.sala.light).toBe(1);
    expect(back.state.ruleset.conditions.map((d) => d.id)).toEqual(['cego', 'visao_turva', 'ofuscado', 'surdo']);
    expect(back.state.characters.kenji.conditions).toEqual([]);
    expect(sightOf(back.state, 'kenji', 'mei')).toBe('nitido');
  });

  it('o replay mostra a luz e as condições de cada momento', () => {
    const e = room();
    lantern(e, false);
    const before = snapshotScene(e.state);
    e.updateLocation({ location_id: 'sala', light: 0.05 });
    e.updateItem({ item_id: 'lanterna', light_on: true });
    e.updateCharacter({ character_id: 'kenji', conditions_add: ['cego'] });
    const past = sceneAt(e.state, before);
    expect(past.locations.sala.light).toBe(1);
    expect(past.items.lanterna.light?.on).toBe(false);
    expect(past.characters.kenji.conditions).toEqual([]);
    expect(e.state.characters.kenji.conditions).toEqual([{ id: 'cego', until: null }]);
  });
});
