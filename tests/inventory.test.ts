import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';

/** Professor (jogador) em (6,1) com dois gizes, e Yuki ao lado dele, em (7,1). */
function room(): GameEngine {
  const e = GameEngine.create('teste', 3);
  e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { x: 6, y: 1 } });
  e.createCharacter({ name: 'Yuki Sato', role: 'aluna', appearance: '', position: { x: 7, y: 1 } });
  e.createItem({ id: 'giz', name: 'Giz', description: '', quantity: 2, holder: { character_id: 'kenji' } });
  return e;
}

function magician(e: GameEngine) {
  e.extendRuleset({
    reason: 'mágico de palco',
    perks: [{ name: 'Bolso sem fundo', description: '', grants: [{ kind: 'conjure', note: 'objetos pequenos', cost: { resource: 'energia', amount: 4 } }] }],
  });
  e.updateCharacter({ character_id: 'kenji', perks_add: ['bolso_sem_fundo'] });
}

describe('inventário do jogador', () => {
  it('na criação do mundo, o inventário inicial vale', () => {
    expect(room().state.items.giz.holder).toEqual({ kind: 'character', id: 'kenji' });
  });

  it('no meio do jogo, nada surge no bolso do jogador nem a pilha dele cresce sozinha', () => {
    const e = room();
    e.beginTurn();
    const bomb = runTool(e, 'create_items', { items: [{ name: 'Bomba de fedor', description: '', holder: { character_id: 'jogador' } }] });
    expect(bomb.ok).toBe(false);
    expect(bomb.content).toMatch(/^"Bomba de fedor" não pode surgir com Kenji Tanaka: o jogador só tem o que está no inventário dele/);
    expect(Object.keys(e.state.items)).toEqual(['giz']);
    const more = runTool(e, 'update_item', { item_id: 'giz', quantity_delta: 5 });
    expect(more.content).toMatch(/^Mais Giz não pode surgir com Kenji Tanaka/);
    expect(e.state.items.giz.quantity).toBe(2);
    expect(runTool(e, 'update_item', { item_id: 'giz', quantity_delta: -1 }).ok).toBe(true);
  });

  it('o que existe no mundo chega até ele pelas mãos de alguém', () => {
    const e = room();
    e.beginTurn();
    expect(runTool(e, 'create_items', { items: [{ id: 'bomba', name: 'Bomba de fedor', description: '', holder: { character_id: 'yuki' } }] }).ok).toBe(true);
    expect(runTool(e, 'transfer_item', { item_id: 'bomba', to: { character_id: 'kenji' } }).ok).toBe(true);
    expect(e.state.items.bomba.holder).toEqual({ kind: 'character', id: 'kenji' });
  });

  it('com perk de conjurar, o item surge e o perk cobra o custo', () => {
    const e = room();
    magician(e);
    e.beginTurn();
    const r = runTool(e, 'create_items', { items: [{ name: 'Bomba de fedor', description: '', holder: { character_id: 'kenji' } }] });
    expect(r.summary).toBe('✨ Bomba de fedor (com Kenji Tanaka) · Bolso sem fundo');
    expect(e.state.characters.kenji.resources.energia).toBe(6);
    runTool(e, 'create_items', { items: [{ name: 'Moeda', description: '', holder: { character_id: 'kenji' } }] });
    const broke = runTool(e, 'create_items', { items: [{ name: 'Lenço', description: '', holder: { character_id: 'kenji' } }] });
    expect(broke.content).toBe('Kenji Tanaka não tem energia para Bolso sem fundo: precisa de 4 e tem 2.');
    expect(e.state.characters.kenji.resources.energia).toBe(2);
  });

  it('o resumo lembra o mestre do que o jogador tem e de quem pode conjurar', () => {
    const e = room();
    expect(compileBrief(e)).toContain('Inventário: Giz [giz] ×2. É tudo o que ele tem: nada surge com ele.');
    magician(e);
    expect(compileBrief(e)).toContain(
      'É tudo o que ele tem: nada surge com ele, salvo pelo perk Bolso sem fundo (tira itens do nada: objetos pequenos, custa 4 de energia).',
    );
  });
});
