import { describe, expect, it } from 'vitest';
import { analyzeActs, bodyPose, clipFor, filterActs, handsOf, mainGrip, parseActs, stripActs, GESTURES, POSES } from '../src/engine/body';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { parseBeats } from '../src/engine/frames';
import { playerNarration } from '../src/engine/speech';
import { runTool } from '../src/engine/tools';
import { SYSTEM_PROMPT, verifierPrompt } from '../src/gm/prompts';
import { distanceToRect } from '../src/engine/text';

/** Um galpão 10×7 com uma cama: o guarda (3,2) e o ladrão (6,2), a 3 tiles; a jogadora em (5,4). */
function galpao(light = 1): GameEngine {
  const e = GameEngine.create('teste', 7);
  e.createLocation({
    id: 'galpao',
    name: 'Galpão',
    description: '',
    light,
    layout: ['##########', '#........#', '#........#', '#........#', '#........#', '#.bb.....D', '##########'],
  });
  e.createCharacter({ name: 'Rita', role: 'detetive', appearance: '', is_player: true, location_id: 'galpao', position: { x: 5, y: 4 } });
  e.createCharacter({ name: 'Guarda', role: 'guarda', appearance: '', location_id: 'galpao', position: { x: 3, y: 2 } });
  e.createCharacter({ name: 'Ladrão', id: 'ladrao', role: 'ladrão', appearance: '', location_id: 'galpao', position: { x: 6, y: 2 } });
  e.introduce({ group: ['rita', 'guarda', 'ladrao'] });
  return e;
}

describe('poses', () => {
  it('o mestre muda a pose com alvo, e andar desfaz', () => {
    const e = galpao();
    const r = runTool(e, 'update_character', { character_id: 'guarda', pose: 'mirando', pose_target: 'ladrao' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('mirando');
    expect(e.state.characters.guarda).toMatchObject({ pose: 'mirando', poseTarget: 'ladrao' });
    // Pose nova sem alvo solta o alvo da anterior.
    e.updateCharacter({ character_id: 'guarda', pose: 'maos_ao_alto' });
    expect(e.state.characters.guarda).toMatchObject({ pose: 'maos_ao_alto', poseTarget: null });
    e.moveCharacter({ character_id: 'guarda', to: { x: 4, y: 3 } });
    expect(e.state.characters.guarda).toMatchObject({ pose: null, poseTarget: null });
    expect(bodyPose(e.state, e.state.characters.guarda)).toBe('de_pe');
  });

  it('recusa pose que não existe e alvo de outro lugar', () => {
    const e = galpao();
    expect(runTool(e, 'update_character', { character_id: 'guarda', pose: 'voando' }).ok).toBe(false);
    expect(() => e.updateCharacter({ character_id: 'guarda', pose: 'voando' })).toThrow(/ajoelhado/);
    e.createLocation({ id: 'rua', name: 'Rua', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
    e.createCharacter({ name: 'Zeca', role: 'passante', appearance: '', location_id: 'rua', position: { x: 1, y: 1 } });
    expect(() => e.updateCharacter({ character_id: 'guarda', pose: 'mirando', pose_target: 'zeca' })).toThrow(/mesmo local/);
  });

  it('assento, cama e vida em 0 decidem a pose', () => {
    const e = galpao();
    const bed = e.state.locations.galpao.fixtures.find((f) => f.kind === 'bed')!;
    e.moveCharacter({ character_id: 'ladrao', to: { seat: bed.id } });
    expect(bodyPose(e.state, e.state.characters.ladrao)).toBe('deitado');
    e.updateCharacter({ character_id: 'guarda', pose: 'ajoelhado', resources_set: { vida: 0 } });
    expect(bodyPose(e.state, e.state.characters.guarda)).toBe('caido');
    // Deitado continua deitado: já está no chão.
    e.updateCharacter({ character_id: 'guarda', pose: 'deitado' });
    expect(bodyPose(e.state, e.state.characters.guarda)).toBe('deitado');
  });

  it('pose que não se faz sentado levanta quem está na cama; as de sentado, não', () => {
    const e = galpao();
    const bed = e.state.locations.galpao.fixtures.find((f) => f.kind === 'bed')!;
    e.moveCharacter({ character_id: 'ladrao', to: { seat: bed.id } });
    // Antes, deitado na cama, de_pe virava "sem mudanças": o assento mandava no corpo.
    const r = runTool(e, 'update_character', { character_id: 'ladrao', pose: 'de_pe' });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('de pé (levantou da cama)');
    const ladrao = e.state.characters.ladrao;
    expect(ladrao.seatId).toBeNull();
    expect(distanceToRect(ladrao.pos!, bed)).toBe(1);
    expect(bodyPose(e.state, ladrao)).toBe('de_pe');
    // Pensativo dá para ficar deitado; ajoelhar sai da cama e ajoelha ao lado dela.
    e.moveCharacter({ character_id: 'guarda', to: { seat: bed.id } });
    e.updateCharacter({ character_id: 'guarda', pose: 'pensativo' });
    expect(bodyPose(e.state, e.state.characters.guarda)).toBe('deitado');
    const r2 = e.updateCharacter({ character_id: 'guarda', pose: 'ajoelhado' });
    expect(r2.stood_up?.from).toBe(bed.id);
    expect(e.state.characters.guarda.seatId).toBeNull();
    expect(bodyPose(e.state, e.state.characters.guarda)).toBe('ajoelhado');
  });

  it('o retrato do replay guarda a pose', () => {
    const e = galpao();
    e.updateCharacter({ character_id: 'guarda', pose: 'mirando', pose_target: 'ladrao' });
    e.recordFrame();
    expect(e.state.frames.at(-1)!.characters.guarda).toMatchObject({ pose: 'mirando', poseTarget: 'ladrao' });
  });

  it('o clipe vem da arma na mão, e variantes ficam sempre as mesmas por personagem', () => {
    expect(clipFor(POSES.mirando.clip, 'pistola', 'x')).toBe('pistola_mira');
    expect(clipFor(POSES.mirando.clip, 'arma_longa', 'x')).toBe('fuzil_mira');
    expect(clipFor(POSES.mirando.clip, null, 'x')).toBe('pistola_mira');
    expect(clipFor(GESTURES.ataca.clip, 'uma_mao', 'x')).toBe('espada_ataque');
    expect(clipFor(GESTURES.ataca.clip, null, 'x')).toBe('soco');
    const caido = POSES.caido.clip;
    expect(clipFor(caido, null, 'guarda')).toBe(clipFor(caido, null, 'guarda'));
  });
});

describe('item na mão', () => {
  it('empunhar é mandar para a mão; o arco vai na esquerda e o fuzil ocupa as duas', () => {
    const e = galpao();
    e.createItem({ name: 'Faca', description: '', holder: { character_id: 'guarda', hand: 'esquerda' }, grip: 'uma_mao' });
    e.createItem({ name: 'Pistola', description: '', holder: { character_id: 'guarda' }, grip: 'pistola', model: 'qualquer:Coisa' });
    const r = runTool(e, 'transfer_item', { item_id: 'pistola', to: { character_id: 'guarda', hand: 'direita' } });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('✋ Pistola: com Guarda → na mão direita de Guarda');
    expect(handsOf(e.state, 'guarda')).toMatchObject({ direita: { id: 'pistola' }, esquerda: { id: 'faca' } });
    expect(mainGrip(e.state, 'guarda')).toMatchObject({ grip: 'pistola' });

    e.createItem({ name: 'Arco', description: '', holder: { character_id: 'guarda' }, grip: 'arco' });
    e.transferItem({ item_id: 'arco', to: { character_id: 'guarda', hand: 'direita' } });
    expect(e.state.items.arco.holder).toMatchObject({ hand: 'esquerda' });
    // O arco tomou a esquerda: a faca volta a ficar guardada.
    expect(e.state.items.faca.holder).toEqual({ kind: 'character', id: 'guarda' });
    expect(mainGrip(e.state, 'guarda')).toMatchObject({ grip: 'arco' });

    e.createItem({ name: 'Fuzil', description: '', holder: { character_id: 'guarda' }, grip: 'arma_longa' });
    const fuzil = e.transferItem({ item_id: 'fuzil', to: { character_id: 'guarda', hand: 'esquerda' } });
    expect(fuzil.stowed).toEqual(['Pistola', 'Arco']);
    expect(handsOf(e.state, 'guarda')).toMatchObject({ direita: { id: 'fuzil' }, esquerda: { id: 'fuzil' } });

    // Guardar é mandar de volta sem a mão; entregar a outro tira da mão.
    e.transferItem({ item_id: 'fuzil', to: { character_id: 'guarda' } });
    expect(mainGrip(e.state, 'guarda')).toBeNull();
    expect(() => e.transferItem({ item_id: 'faca', to: { fixture_id: 'galpao/cama-1', hand: 'direita' } })).toThrow(/mão de alguém/);
  });

  it('jeito de empunhar inválido é recusado', () => {
    const e = galpao();
    expect(() => e.createItem({ name: 'Lança', description: '', holder: { character_id: 'guarda' }, grip: 'tres_maos' })).toThrow(/duas_maos/);
  });

  it('o resumo do turno diz a pose e o que cada um tem na mão', () => {
    const e = galpao();
    e.createItem({ name: 'Pistola', description: '', holder: { character_id: 'guarda', hand: 'direita' }, grip: 'pistola' });
    e.createItem({ name: 'Lanterna', description: '', holder: { character_id: 'rita', hand: 'esquerda' } });
    e.updateCharacter({ character_id: 'guarda', pose: 'mirando', pose_target: 'ladrao' });
    const brief = compileBrief(e);
    expect(brief).toMatch(/Guarda \[guarda\].*mirando \(ladrao\).*na mão: Pistola \[pistola\]/);
    expect(brief).toContain('Lanterna [lanterna] (na mão esquerda)');
  });
});

describe('gestos na narração', () => {
  it('lê e tira as marcas do texto', () => {
    const text = 'O guarda dispara. {guarda:ataca>ladrao} {ladrao:esquiva}';
    expect(parseActs(text)).toEqual([
      { actorId: 'guarda', gesture: 'ataca', targetId: 'ladrao' },
      { actorId: 'ladrao', gesture: 'esquiva', targetId: null },
    ]);
    expect(stripActs(text)).toBe('O guarda dispara.');
    expect(stripActs('Ele acena {rita:acena} , sorrindo.')).toBe('Ele acena, sorrindo.');
    expect(filterActs(text, (a) => a.actorId === 'guarda')).toBe('O guarda dispara. {guarda:ataca>ladrao}');
  });

  it('o motor confere quem, qual gesto, o alvo e o alcance do ataque', () => {
    const e = galpao();
    const issues = (text: string) => analyzeActs(e.state, text);
    expect(issues('{guarda:acena>rita} {guarda:sim}')).toEqual([]);
    expect(issues('{fulano:acena}')).toEqual([expect.stringContaining('não é id de personagem')]);
    expect(issues('{guarda:pular>ladrao}')).toEqual([expect.stringMatching(/"pular".*não existe/)]);
    // Sinônimos e infinitivos viram o gesto da tabela.
    expect(parseActs('{guarda:atirar>ladrao} {guarda:acenar} {guarda:aplaudir} {guarda:cambalear}').map((a) => a.gesture)).toEqual(['ataca', 'acena', 'aplaude', 'cambaleia']);
    // De mãos vazias, a 3 tiles, não alcança; com a pistola na mão, alcança.
    expect(issues('{guarda:ataca>ladrao}')).toEqual([expect.stringMatching(/a 3 tiles sem arma de alcance.*transfer_item/)]);
    e.createItem({ name: 'Pistola', description: '', holder: { character_id: 'guarda', hand: 'direita' }, grip: 'pistola' });
    expect(issues('{guarda:ataca>ladrao}')).toEqual([]);
    e.moveCharacter({ character_id: 'ladrao', to: { x: 4, y: 2 } });
    expect(issues('{ladrao:ataca>guarda}')).toEqual([]);
    e.updateCharacter({ character_id: 'ladrao', resources_set: { vida: 0 } });
    expect(issues('{ladrao:punho>guarda}')).toEqual([expect.stringContaining('fora de ação')]);
  });

  it('a versão do jogador tira os gestos de quem ele não vê e mantém os de quem ele vê', () => {
    const e = galpao(0);
    // No breu, a jogadora só vê o guarda, que segura uma lanterna acesa; o ladrão fica no escuro.
    e.moveCharacter({ character_id: 'guarda', to: { x: 5, y: 3 } });
    e.moveCharacter({ character_id: 'ladrao', to: { x: 8, y: 1 } });
    e.createItem({ name: 'Lanterna', description: '', holder: { character_id: 'guarda', hand: 'esquerda' }, light: { radius: 2, intensity: 1, on: true } });
    const shown = playerNarration(e.state, 'Barulho no escuro. {ladrao:ataca>guarda} {guarda:atingido>ladrao}');
    expect(parseActs(shown).map((a) => a.actorId)).toEqual(['guarda']);
    // A fala que ela não ouve vira só o gesto, e o gesto marcado fica.
    const whisper = playerNarration(galpao().state, '@guarda[cochicho>ladrao]: Agora. {guarda:aponta>rita}');
    expect(whisper).toMatch(/^@guarda\[cochicho>ladrao\|oculto\]: cochicha algo para Ladrão \{guarda:aponta>rita\}$/);
  });

  it('linha só de marcas vai para o passo seguinte do replay', () => {
    const beats = parseBeats('{guarda:saca}\n\n@guarda: Parado!\nEle atira. {guarda:ataca>ladrao}\n\n{ladrao:cambaleia}');
    expect(beats.map((b) => b.text)).toEqual(['{guarda:saca} Parado!', 'Ele atira. {guarda:ataca>ladrao} {ladrao:cambaleia}']);
  });

  it('o prompt do mestre lista poses e gestos da tabela', () => {
    expect(SYSTEM_PROMPT).toContain('maos_ao_alto');
    expect(SYSTEM_PROMPT).toContain('ataca (soco, golpe, tiro ou flecha, pelo que empunha)');
    expect(SYSTEM_PROMPT).toContain('{id:gesto>alvo}');
    expect(SYSTEM_PROMPT).toContain('levantar é update_character com pose de_pe');
  });

  it('o verificador cobra postura, passos e gestos da tabela sem marca', () => {
    const prompt = verifierPrompt({ state: '', changes: [], input: '', narration: '' });
    expect(prompt).toContain('recua, se afasta');
    expect(prompt).toContain('se levanta, senta, deita, se ajoelha ou cai');
    expect(prompt).toContain('gesto sem marca');
    expect(prompt).toContain('encolhe_ombros');
  });
});
