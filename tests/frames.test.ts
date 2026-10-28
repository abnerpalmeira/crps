import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { parseBeats, sceneAt } from '../src/engine/frames';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';

describe('parseBeats', () => {
  it('separa falas @id da narração, na ordem', () => {
    const beats = parseBeats(
      ['O sinal toca.', 'A turma se ajeita.', '@Haruka: Levantar!', '@kenta: Bom dia! *mastigando*', '', 'Silêncio. E o e-mail @fulano: nada.'].join('\n'),
    );
    expect(beats).toEqual([
      { kind: 'narration', text: 'O sinal toca. A turma se ajeita.' },
      { kind: 'speech', speakerId: 'haruka', text: 'Levantar!' },
      { kind: 'speech', speakerId: 'kenta', text: 'Bom dia! *mastigando*' },
      { kind: 'narration', text: 'Silêncio. E o e-mail @fulano: nada.' },
    ]);
  });

  it('quebra parágrafos longos em legendas que terminam em fim de frase', () => {
    const sentence = 'Esta frase tem mais ou menos sessenta caracteres de comprimento. ';
    const beats = parseBeats(sentence.repeat(10).trim());
    expect(beats.length).toBeGreaterThan(1);
    expect(beats.every((b) => b.kind === 'narration' && b.text.length <= 240 && b.text.endsWith('.'))).toBe(true);
  });
});

describe('retratos da cena', () => {
  it('recompõe posições, itens e quadro de um turno passado', () => {
    const e = GameEngine.create('teste', 5);
    e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
    e.createCharacter({ name: 'Kenji', role: 'professor', appearance: '', is_player: true, position: { near: 'sala/quadro-1' } });
    e.createCharacter({ name: 'Yuki', role: 'aluna', appearance: '', position: { seat: 'sala/carteira-1' } });
    e.createItem({ name: 'Giz', description: '', holder: { character_id: 'kenji' } });
    e.recordFrame();
    const before = structuredClone(e.state.frames[0]);

    e.beginTurn();
    e.moveCharacter({ character_id: 'yuki', to: { near: 'sala/quadro-1' } });
    e.transferItem({ item_id: 'giz', to: { character_id: 'yuki' } });
    e.updateFixture({ fixture_id: 'sala/quadro-1', text: 'Período Edo' });
    e.createCharacter({ name: 'Diretor', role: 'diretor', appearance: '', position: { near: 'sala/porta-1' } });
    e.recordFrame();
    expect(e.state.frames.map((f) => f.turn)).toEqual([0, 1]);

    const past = sceneAt(e.state, before);
    expect(past.characters.yuki).toMatchObject({ seatId: 'sala/carteira-1', pos: { x: 2, y: 4 } });
    expect(past.characters.diretor).toBeUndefined();
    expect(past.items.giz.holder).toEqual({ kind: 'character', id: 'kenji' });
    expect(past.locations.sala.fixtures.find((f) => f.kind === 'board')!.text).toBe('');
    expect(e.state.characters.yuki.seatId).toBeNull();
    expect(sceneAt(e.state, undefined)).toBe(e.state);
  });
});
