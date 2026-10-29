import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';
import { figureOf } from '../src/client/models';
import { SYSTEM_PROMPT, systemPrompt } from '../src/gm/prompts';

function room(): GameEngine {
  const e = GameEngine.create('teste', 3);
  e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
  return e;
}

describe('corpo do personagem no 3D', () => {
  it('o mestre informa o corpo ao criar e pode mudar depois', () => {
    const e = room();
    const r = runTool(e, 'create_characters', {
      characters: [
        { name: 'Kenji Tanaka', role: 'professor', appearance: '', figure: 'adulto', is_player: true, position: { x: 6, y: 1 } },
        { name: 'Yuki Sato', role: 'aluna', appearance: '', figure: 'menina', position: { seat: 'sala/carteira-1' } },
      ],
    });
    expect(r.ok).toBe(true);
    expect(e.state.characters.yuki.figure).toBe('menina');
    expect(runTool(e, 'update_character', { character_id: 'yuki', figure: 'adulta' }).summary).toBe('✏️ Yuki Sato: figure');
    expect(runTool(e, 'update_character', { character_id: 'yuki', figure: 'robô' }).ok).toBe(false);
  });

  it('sem o corpo informado, o papel decide; no empate, o id sorteia de forma estável', () => {
    const e = room();
    e.createCharacter({ name: 'Ana', role: 'aluna do 2º ano', appearance: '' });
    e.createCharacter({ name: 'Rui', role: 'diretor da escola', appearance: '' });
    e.createCharacter({ name: 'Sam', role: 'aluno(a) do 2º ano', appearance: '' });
    e.createCharacter({ name: 'Lee', role: 'segurança', appearance: '' });
    expect(figureOf(e.state.characters.ana)).toBe('menina');
    expect(figureOf(e.state.characters.rui)).toBe('adulto');
    expect(['menino', 'menina']).toContain(figureOf(e.state.characters.sam));
    expect(['adulto', 'adulta']).toContain(figureOf(e.state.characters.lee));
    expect(figureOf(e.state.characters.lee)).toBe(figureOf(e.state.characters.lee));
  });

  it('sem papel que diga o corpo, a aparência decide antes do sorteio', () => {
    const e = room();
    e.createCharacter({ name: 'Lu', role: 'segurança', appearance: 'Mulher de uns quarenta anos, cabelo curto' });
    e.createCharacter({ name: 'Bia', role: 'desconhecido', appearance: 'Adolescente de mochila; a garota não tira o fone' });
    expect(figureOf(e.state.characters.lu)).toBe('adulta');
    expect(figureOf(e.state.characters.bia)).toBe('menina');
  });

  it('o mestre escolhe o visual do 3D e descreve a aparência a partir dele', () => {
    const e = room();
    runTool(e, 'create_characters', {
      characters: [{ name: 'Dona Lúcia', role: 'moradora', appearance: 'mulher de cabelo castanho preso, vestido roxo', look: 'mother_2', position: { x: 6, y: 1 } }],
    });
    expect(e.state.characters.dona.look).toBe('mother_2');
    expect(runTool(e, 'update_character', { character_id: 'dona', look: 'female_coat' }).summary).toBe('✏️ Dona Lúcia: look');
    const prompt = systemPrompt([{ id: 'mother_2', figure: 'adulta', look: 'mulher de cabelo castanho preso, vestido roxo sem mangas com listras amarelas' }]);
    expect(prompt.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('# Visual dos personagens');
    expect(prompt).toContain('- mother_2 (adulta): mulher de cabelo castanho preso, vestido roxo sem mangas com listras amarelas');
    expect(systemPrompt([])).toBe(SYSTEM_PROMPT);
  });
});
