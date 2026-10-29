import { describe, expect, it } from 'vitest';
import { formatNarration } from '../src/client/format';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { findByName, parsePlayerInput } from '../src/engine/input';
import { perceptionOf } from '../src/engine/perception';
import { analyzeSpeech, playerNarration } from '../src/engine/speech';
import { runTool } from '../src/engine/tools';

/** Galeria com a vigia (jogadora) em (6,1) e o curador a 4 tiles, em (2,3); luz 1 = acesa, 0.15 = quase escuro. */
function gallery(light = 1): GameEngine {
  const e = GameEngine.create('teste', 9);
  e.createLocation({ id: 'galeria', name: 'Galeria', description: '', light, layout: ['#########', '#.......#', '#.......#', '#.......#', '#.......D', '#########'] });
  e.createLocation({ id: 'patio', name: 'Pátio', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
  e.createCharacter({ name: 'Marta Queiroz', role: 'vigia', appearance: '', figure: 'adulta', is_player: true, location_id: 'galeria', position: { x: 6, y: 1 } });
  e.createCharacter({ name: 'Otávio Ramos', role: 'curador', appearance: 'Homem alto de terno.', figure: 'adulto', seen_as: 'o homem de terno', location_id: 'galeria', position: { x: 2, y: 3 } });
  return e;
}

describe('conhecidos', () => {
  it('estranho não tem nome para o jogador até ser apresentado', () => {
    const e = gallery();
    expect(runTool(e, 'move_character', { character_id: 'otavio', to: { x: 3, y: 3 } }).summary).toMatch(/^🚶 o homem de terno → /);
    expect(playerNarration(e.state, '@otavio: Boa noite.')).toBe('@otavio[fala|como o homem de terno]: Boa noite.');
    expect(compileBrief(e)).toContain('o jogador NÃO conhece: para ele é "o homem de terno"');

    const r = runTool(e, 'introduce', { who: ['marta'], knows: ['Otávio'] });
    expect(r.summary).toBe('🤝 Você conhece: Otávio Ramos');
    expect(e.state.characters.otavio.knows).toEqual(['marta']);
    expect(playerNarration(e.state, '@otavio: Boa noite.')).toBe('@otavio: Boa noite.');
    expect(runTool(e, 'introduce', { group: ['marta', 'otavio'] }).summary).toBe('🤫 Conhecidos: nada novo');
  });

  it('no escuro, o conhecido é reconhecido pela voz quando fala, e a voz de um estranho fica sem nome', () => {
    const e = gallery(0.15);
    e.introduce({ group: ['marta', 'otavio'] });
    e.createCharacter({ name: 'Bia Tavares', role: 'estagiária', appearance: '', figure: 'adulta', location_id: 'galeria', position: { x: 2, y: 4 } });
    const view = () => perceptionOf(e.state, 'marta');
    expect(view().sight('otavio')).toBe('vulto');
    expect(view().recognize('otavio')).toBeNull();
    expect(compileBrief(e)).toContain('o jogador conhece, mas não sabe que é ele(a)');

    const text = 'Uma silhueta se move.\n@otavio: Marta, desculpe a hora.\n@bia: Quem está aí?';
    expect(playerNarration(e.state, text)).toBe('Uma silhueta se move.\n@otavio: Marta, desculpe a hora.\n@bia[fala|como uma voz de mulher]: Quem está aí?');
    e.hearVoices(analyzeSpeech(e.state, text).lines);
    expect(view().recognize('otavio')).toBe('voz');
    expect(view().recognize('bia')).toBeNull();
    expect(compileBrief(e)).toContain('o jogador reconhece pela voz');

    // Quem sai e volta precisa ser ouvido de novo.
    e.moveCharacter({ character_id: 'otavio', to: { location_id: 'patio' }, via: 'porta-1' });
    e.moveCharacter({ character_id: 'otavio', to: { location_id: 'galeria', x: 2, y: 3 } });
    expect(view().recognize('otavio')).toBeNull();
  });

  it('o jogador não percebe cochicho de quem ele nem vê nem ouve', () => {
    const e = gallery(0);
    e.createCharacter({ name: 'Bia Tavares', role: 'estagiária', appearance: '', location_id: 'galeria', position: { x: 2, y: 4 } });
    expect(playerNarration(e.state, 'Silêncio.\n@otavio[cochicho>bia]: Esconde isso.')).toBe('Silêncio.');
  });

  it('save antigo: todos se conhecem, e a última fala ouvida vale como voz reconhecida', () => {
    const e = gallery(0.15);
    e.log('narration', 'A voz vem da porta.\n@otavio: Marta, desculpe a hora.');
    const raw = JSON.parse(e.toJSON());
    for (const c of Object.values(raw.characters) as Record<string, unknown>[]) {
      delete c.knows;
      delete c.voices;
    }
    const loaded = GameEngine.fromJSON(JSON.stringify(raw));
    expect(loaded.state.characters.marta.knows).toEqual(['otavio']);
    expect(loaded.state.characters.marta.voices).toEqual({ otavio: 'galeria' });
    expect(perceptionOf(loaded.state, 'marta').recognize('otavio')).toBe('voz');
  });

  it('o jogador sussurra para um estranho pela descrição, e o chat não mostra o nome nem a cor', () => {
    const e = gallery();
    expect(parsePlayerInput('@[o homem de terno] "Boa noite."')).toEqual([{ kind: 'sussurro', target: 'o homem de terno', text: 'Boa noite.' }]);
    expect(findByName(e.state, 'o homem de terno')?.id).toBe('otavio');
    const html = formatNarration('@otavio[fala|como o homem de terno]: Boa noite.', () => ({ name: 'Otávio Ramos', color: 'red' }));
    expect(html).toContain('<b class="unknown">O homem de terno</b>');
    expect(html).not.toContain('Otávio');
  });
});
