import { beforeEach, describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { EngineError, GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM, runTool, toolSpecs } from '../src/engine/tools';

/** Mundo da cena da sala de aula, montado como o modelo montaria. */
function classroom(seed = 42): GameEngine {
  const e = GameEngine.create('Slice of life: sou professor e começo o dia com um giz.', seed);
  e.defineRuleset({
    name: 'Escola',
    attributes: [
      { name: 'Paciência', description: '' },
      { name: 'Carisma', description: '' },
      { name: 'Didática', description: '' },
    ],
    resources: [{ name: 'Energia', max: 10, description: '' }],
  });
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula japonesa.', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({
    name: 'Kenji Tanaka',
    role: 'professor de história',
    appearance: 'camisa social amassada',
    is_player: true,
    position: { near: 'sala/quadro-1' },
    attributes: { paciencia: 3, 'Didática': 2 },
  });
  for (const name of ['Yuki Sato', 'Haruto Mori', 'Aiko Ueda', 'Ren Ito', 'Mei Kato']) {
    e.createCharacter({ name, role: 'aluno(a)', appearance: 'uniforme', position: { seat: 'random' } });
  }
  e.createItem({ name: 'Giz', description: 'giz branco', holder: { character_id: 'kenji' } });
  return e;
}

describe('GameEngine', () => {
  let e: GameEngine;
  beforeEach(() => {
    e = classroom();
  });

  it('cria o jogador perto do quadro e os alunos em carteiras distintas', () => {
    expect(e.player?.id).toBe('kenji');
    expect(e.player?.pos).toEqual({ x: 6, y: 1 });
    expect(e.player?.attributes).toEqual({ paciencia: 3, carisma: 1, didatica: 2 });
    const seats = Object.values(e.state.characters).filter((c) => !c.isPlayer).map((c) => c.seatId);
    expect(new Set(seats).size).toBe(5);
    expect(seats.every((s) => s?.startsWith('sala/carteira-'))).toBe(true);
    expect(e.findCharacter('yuki').facing).toBe('N');
  });

  it('gera ids a partir do primeiro nome, pulando títulos', () => {
    const c = e.createCharacter({ name: 'Prof. Watanabe', role: 'diretor', appearance: 'terno', position: { near: 'sala/porta-1' } });
    expect(c.id).toBe('watanabe');
  });

  it('impede dois personagens do jogador e assento ocupado', () => {
    expect(() => e.createCharacter({ name: 'Outro', role: 'x', appearance: 'x', is_player: true })).toThrow(EngineError);
    const yuki = e.findCharacter('Yuki');
    expect(() => e.moveCharacter({ character_id: 'haruto', to: { seat: yuki.seatId! } })).toThrow(/ocupad/);
  });

  it('move por caminho e ao lado de alguém', () => {
    const r = e.moveCharacter({ character_id: 'yuki', to: { near: 'sala/quadro-1' } });
    expect(r.steps).toBeGreaterThan(0);
    expect(e.findCharacter('yuki').seatId).toBeNull();
    const beside = e.moveCharacter({ character_id: 'kenji', to: { near: 'yuki' }, face: 'yuki' });
    const [k, y] = [e.findCharacter('kenji').pos!, e.findCharacter('yuki').pos!];
    expect(Math.max(Math.abs(k.x - y.x), Math.abs(k.y - y.y))).toBe(1);
    expect(beside.facing).toBeDefined();
    expect(() => e.moveCharacter({ character_id: 'kenji', to: { x: 6, y: 2 } })).toThrow(/mesa do professor/);
  });

  it('exige proximidade para entregar itens e divide pilhas', () => {
    const far = Object.values(e.state.characters).find((c) => !c.isPlayer && c.pos!.y >= 6)!;
    expect(() => e.transferItem({ item_id: 'giz', to: { character_id: far.id } })).toThrow(/alcance 2/);
    e.moveCharacter({ character_id: 'kenji', to: { near: far.id } });
    expect(e.transferItem({ item_id: 'giz', to: { character_id: far.id } }).to).toContain(far.name);

    e.createItem({ name: 'Folhas', description: 'folhas de prova', quantity: 10, holder: { character_id: 'kenji' } });
    const split = e.transferItem({ item_id: 'folhas', to: { character_id: far.id }, quantity: 3 });
    expect(split.item_id).toBe('folhas_2');
    expect(e.state.items.folhas.quantity).toBe(7);
    expect(e.state.items.folhas_2).toMatchObject({ quantity: 3, holder: { kind: 'character', id: far.id } });
  });

  it('rola testes de forma determinística a partir da semente', () => {
    const roll = () =>
      classroom(7).skillCheck({ character_id: 'kenji', attribute: 'Paciência', skill: 'oratória', difficulty: 'normal', reason: 'acalmar a turma' });
    const a = roll();
    expect(roll()).toEqual(a);
    expect(a.total).toBe(a.rolls[0] + a.rolls[1] + 3);
    expect(a.target).toBe(9);
    expect(a.success).toBe(a.total >= 9);
  });

  it('registra e recupera fatos com quem sabe', () => {
    e.addFact({ subject: 'Yuki', text: 'Yuki tem medo de falar em público', known_by: ['yuki'] });
    e.addFact({ subject: 'sala', text: 'A janela do fundo não fecha direito', known_by: 'all' });
    e.addFact({ subject: 'haruto', text: 'Haruto prometeu trazer o trabalho amanhã', known_by: ['haruto', 'player'] });
    expect(e.recall({ query: 'medo publico' }).facts.map((f) => f.subject)).toEqual(['yuki']);
    expect(e.state.facts[2].knownBy).toEqual(['haruto', 'kenji']);
    expect(() => e.addFact({ subject: 'x', text: 'y', known_by: ['ninguem'] })).toThrow(/não existe/);
  });

  it('define o horário inicial na criação e depois só avança', () => {
    e.advanceTime({ to: '07:50' });
    expect(e.state.clock).toEqual({ day: 1, minutes: 470 });
    e.beginTurn();
    e.advanceTime({ minutes: 30 });
    expect(e.state.clock.minutes).toBe(500);
    e.advanceTime({ to: '07:00' });
    expect(e.state.clock).toEqual({ day: 2, minutes: 420 });
  });

  it('escreve no quadro e acha móveis pelo id curto', () => {
    e.updateFixture({ fixture_id: 'quadro-1', text: '28/10 — Segunda-feira' });
    expect(e.findFixture('sala/quadro-1').text).toBe('28/10 — Segunda-feira');
  });
});

describe('runTool', () => {
  it('valida a entrada com zod', () => {
    const r = runTool(classroom(), 'move_character', { character_id: 5 });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/^Entrada inválida para move_character/);
  });

  it('desfaz mudanças parciais quando a regra falha', () => {
    const e = classroom();
    const r = runTool(e, 'create_items', {
      items: [
        { name: 'Apagador', description: 'apagador de feltro', holder: { character_id: 'kenji' } },
        { name: 'Livro', description: 'livro', holder: { character_id: 'ninguem' } },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/ninguem/);
    expect(e.state.items.apagador).toBeUndefined();
  });

  it('cria personagens em lote e devolve só os erros a corrigir', () => {
    const e = classroom();
    const r = runTool(e, 'create_characters', {
      characters: [
        { name: 'Sora Abe', role: 'aluno', appearance: 'óculos', position: { seat: 'random' } },
        { name: 'Fantasma', role: 'x', appearance: 'x', position: { x: 0, y: 0 } },
      ],
    });
    expect(r.ok).toBe(true);
    const content = JSON.parse(r.content);
    expect(content.created).toHaveLength(1);
    expect(content.errors[0]).toMatchObject({ index: 1, name: 'Fantasma' });
    expect(r.summary).toContain('1 com erro');
  });

  it('publica 16 tools com JSON Schema estável', () => {
    const specs = toolSpecs();
    expect(specs).toHaveLength(16);
    expect(JSON.stringify(toolSpecs())).toBe(JSON.stringify(specs));
    expect(JSON.stringify(specs)).not.toContain('9007199254740991');
  });
});

describe('compileBrief', () => {
  it('resume a cena com mapa, personagens, inventário e fatos', () => {
    const e = classroom();
    e.addFact({ subject: 'yuki', text: 'Yuki desenha nos cantos do caderno', known_by: ['yuki'] });
    const brief = compileBrief(e);
    expect(brief).toContain('## Local atual: Sala 1-A [sala]');
    expect(brief).toContain('   01234567890123\n 0 #####BBBB#####\n 1 #.....@......#\n');
    expect(brief).toContain('(VOCÊ, jogador)');
    expect(brief).toContain('Inventário: Giz [giz]');
    expect(brief).toContain('Yuki desenha nos cantos do caderno');
    expect(brief).toMatch(/carteira: 15 no total, livres: /);
  });
});
