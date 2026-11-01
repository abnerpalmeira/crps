import { describe, expect, it } from 'vitest';
import { actionsFor, describeAct, parseMenuActs, type ActionOption } from '../src/engine/actions';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { describeInput, parsePlayerInput } from '../src/engine/input';
import { performMenuAct } from '../src/engine/perform';
import { analyzeReading } from '../src/engine/reading';
import { playerNarration } from '../src/engine/speech';
import { formatNarration, formatPlayerInput } from '../src/client/format';
import { GameMaster } from '../src/gm/gm';
import type { ModelProvider, ModelSession, SessionOptions, StepResult, Verdict } from '../src/gm/provider';

/**
 * Sala 10×7: a jogadora Rita em (2,2), Mei em (4,2), Zeca no fundo (8,5); cadeira em (5,1), cama em
 * (2..3,5), mesa em (7..8,1), piano em (5..6,5) e uma porta para o corredor.
 */
function sala(light = 1): GameEngine {
  const e = GameEngine.create('teste', 5);
  e.createLocation({
    id: 'sala',
    name: 'Sala',
    description: '',
    light,
    layout: ['##########', '#....c.tt#', '#........#', '#........#', '#........#', '#.bbPP...D', '##########'],
    legend: { P: 'piano' },
  });
  e.createLocation({ id: 'corredor', name: 'Corredor', description: '', layout: ['#####', '#...#', 'D...#', '#####'] });
  e.createCharacter({ name: 'Rita', role: 'detetive', appearance: '', is_player: true, location_id: 'sala', position: { x: 2, y: 2 } });
  e.createCharacter({ name: 'Mei', role: 'aluna', appearance: '', location_id: 'sala', position: { x: 4, y: 2 } });
  e.createCharacter({ name: 'Zeca', role: 'zelador', appearance: '', location_id: 'sala', position: { x: 8, y: 5 } });
  e.introduce({ group: ['rita', 'mei', 'zeca'] });
  return e;
}

const labels = (options: ActionOption[]) => options.map((o) => o.label);
const fixture = (e: GameEngine, kind: string) => e.state.locations.sala.fixtures.find((f) => f.kind === kind)!;

describe('ações pelo menu', () => {
  it('cada móvel oferece o que combina com ele', () => {
    const e = sala();
    const chair = fixture(e, 'chair');
    // Sentar é ação livre: acontece na hora, sem esperar o turno do mestre.
    expect(actionsFor(e.state, { kind: 'fixture', id: chair.id })[0]).toMatchObject({
      label: 'Sentar',
      free: { kind: 'act', verb: 'sentar', target: chair.id, other: null },
      note: 'a 3 passos: você vai até lá',
    });
    expect(labels(actionsFor(e.state, { kind: 'fixture', id: fixture(e, 'bed').id }))).toContain('Deitar');
    expect(labels(actionsFor(e.state, { kind: 'fixture', id: fixture(e, 'piano').id }))).toContain('Tocar');
    e.moveCharacter({ character_id: 'mei', to: { seat: chair.id } });
    expect(actionsFor(e.state, { kind: 'fixture', id: chair.id })[0]).toMatchObject({ disabled: true, note: 'ocupado por Mei' });
    // Com algo no bolso, a mesa aceita o item.
    e.createItem({ name: 'Caneta', description: '', holder: { character_id: 'rita' } });
    const table = actionsFor(e.state, { kind: 'fixture', id: fixture(e, 'table').id }).find((o) => o.label === 'Pôr aqui…')!;
    expect(table.options!.map((o) => o.free)).toEqual([{ kind: 'act', verb: 'por', target: 'caneta', other: fixture(e, 'table').id }]);
  });

  it('tipos novos trazem os verbos que o mestre deu', () => {
    const e = sala();
    e.createLocation({
      id: 'bar',
      name: 'Bar',
      description: '',
      layout: ['#######', '#.MM..#', '#.....D', '#######'],
      legend: { M: { label: 'mesa de sinuca', like: 'table', merge: true, actions: ['jogar sinuca'] } },
    });
    e.moveCharacter({ character_id: 'rita', to: { location_id: 'bar' } });
    const sinuca = e.state.locations.bar.fixtures.find((f) => f.kind === 'mesa_de_sinuca')!;
    const option = actionsFor(e.state, { kind: 'fixture', id: sinuca.id }).find((o) => o.label === 'Jogar sinuca')!;
    expect(option.token).toBe(`{jogar_sinuca>${sinuca.id}}`);
  });

  it('item: pegar de longe, e o que dá para fazer com o que está com o jogador', () => {
    const e = sala();
    e.createItem({ name: 'Pedra', description: '', holder: { x: 6, y: 4, location_id: 'sala' } });
    expect(actionsFor(e.state, { kind: 'item', id: 'pedra' })[0]).toMatchObject({
      label: 'Pegar',
      free: { kind: 'act', verb: 'pegar', target: 'pedra', other: null },
      note: 'a 4 passos: você vai até lá',
    });
    e.createItem({ name: 'Pistola', description: '', holder: { character_id: 'rita' }, grip: 'pistola' });
    e.createItem({ name: 'Bilhete', description: '', holder: { character_id: 'rita' }, text: '' });
    e.createItem({ name: 'Lanterna', description: '', holder: { character_id: 'rita' }, light: { radius: 3, intensity: 1 } });
    expect(labels(actionsFor(e.state, { kind: 'item', id: 'pistola' }))).toEqual(['Empunhar', 'Largar', 'Entregar para…']);
    // Sacar uma arma é provocação: vai ao mestre, com o turno.
    expect(actionsFor(e.state, { kind: 'item', id: 'pistola' })[0]).toMatchObject({ token: '{empunhar>pistola}', free: undefined });
    expect(labels(actionsFor(e.state, { kind: 'item', id: 'bilhete' }))).toContain('Ler');
    expect(labels(actionsFor(e.state, { kind: 'item', id: 'lanterna' }))).toContain('Acender');
    // Com a arma na mão, dá para mirar e atacar de longe.
    e.transferItem({ item_id: 'pistola', to: { character_id: 'rita', hand: 'direita' } });
    expect(labels(actionsFor(e.state, { kind: 'item', id: 'pistola' }))[0]).toBe('Guardar');
    expect(labels(actionsFor(e.state, { kind: 'character', id: 'zeca' }))).toEqual(
      expect.arrayContaining(['Falar', 'Sussurrar', 'Ir até', 'Gesto para…', 'Entregar…', 'Mirar com pistola', 'Atacar com pistola']),
    );
  });

  it('o próprio corpo: postura, gestos e levantar', () => {
    const e = sala();
    const self = actionsFor(e.state, { kind: 'character', id: 'rita' });
    expect(labels(self)).toEqual(['Postura…', 'Gesto…']);
    expect(self[0].options!.map((o) => o.free?.kind === 'act' && o.free.target)).toContain('ajoelhado');
    e.moveCharacter({ character_id: 'rita', to: { seat: fixture(e, 'chair').id } });
    expect(labels(actionsFor(e.state, { kind: 'character', id: 'rita' }))[0]).toBe('Levantar');
  });

  it('a marca do menu entra na ação do jogador ao lado das outras', () => {
    const segments = parsePlayerInput('{sentar>sala/cadeira-1} e digo "bom dia" {gesto>acena>mei}');
    expect(segments.map((s) => s.kind)).toEqual(['menu', 'fala', 'menu']);
    expect(segments[2].act).toEqual({ verb: 'gesto', target: 'acena', other: 'mei' });
    expect(parseMenuActs('{entregar>caneta>mei}')).toEqual([{ verb: 'entregar', target: 'caneta', other: 'mei' }]);
    const e = sala();
    expect(describeAct(e.state, { verb: 'entregar', target: 'mei', other: null }, true)).toBe('entregar Mei [mei] para ');
    expect(formatPlayerInput('{sentar>sala/cadeira-1} "oi"', e.state)).toContain('🪑 sentar em cadeira');
  });
});

describe('o motor faz as ações físicas do menu', () => {
  it('sentar, levantar, pegar indo até lá, empunhar, guardar e largar', () => {
    const e = sala();
    const chair = fixture(e, 'chair');
    expect(performMenuAct(e, { verb: 'sentar', target: chair.id, other: null })).toMatchObject({ status: 'feito' });
    expect(e.state.characters.rita.seatId).toBe(chair.id);
    performMenuAct(e, { verb: 'levantar', target: null, other: null });
    expect(e.state.characters.rita.seatId).toBeNull();

    e.createItem({ name: 'Pedra', description: '', holder: { x: 7, y: 4, location_id: 'sala' } });
    const pegar = performMenuAct(e, { verb: 'pegar', target: 'pedra', other: null });
    expect(pegar.status).toBe('feito');
    expect(pegar.tools.map((t) => t.name)).toEqual(['move_character', 'transfer_item']);
    expect(e.state.items.pedra.holder).toEqual({ kind: 'character', id: 'rita' });

    performMenuAct(e, { verb: 'empunhar', target: 'pedra', other: null });
    expect(e.state.items.pedra.holder).toMatchObject({ hand: 'direita' });
    performMenuAct(e, { verb: 'guardar', target: 'pedra', other: null });
    expect(e.state.items.pedra.holder).toEqual({ kind: 'character', id: 'rita' });
    const { x, y } = e.state.characters.rita.pos!;
    performMenuAct(e, { verb: 'largar', target: 'pedra', other: null });
    expect(e.state.items.pedra.holder).toEqual({ kind: 'ground', locationId: 'sala', x, y });
  });

  it('postura e porta que já leva a um lugar', () => {
    const e = sala();
    performMenuAct(e, { verb: 'pose', target: 'ajoelhado', other: null });
    expect(e.state.characters.rita.pose).toBe('ajoelhado');
    const door = e.state.locations.sala.fixtures.find((f) => f.kind === 'door')!;
    // A porta ainda não leva a lugar nenhum: o mestre decide.
    expect(performMenuAct(e, { verb: 'passar', target: door.id, other: null }).status).toBe('mestre');
    e.state.locations.sala.exits[door.id].to = ['corredor'];
    expect(performMenuAct(e, { verb: 'passar', target: door.id, other: null }).status).toBe('feito');
    expect(e.state.characters.rita.locationId).toBe('corredor');
  });

  it('recusa o que não dá e passa ao mestre o que não é físico, com os ids', () => {
    const e = sala();
    e.createItem({ name: 'Caneta', description: '', holder: { character_id: 'mei' } });
    const taken = performMenuAct(e, { verb: 'pegar', target: 'caneta', other: null });
    expect(taken).toMatchObject({ status: 'recusado' });
    expect(taken.line).toContain('está com outra pessoa');
    const give = performMenuAct(e, { verb: 'entregar', target: 'caneta', other: 'zeca' });
    expect(give.status).toBe('mestre');
    // Entregar pede estar perto: o motor leva o jogador até a pessoa, e o mestre decide se ela aceita.
    expect(give.line).toBe(
      '- ação do menu: entregar Caneta [caneta] para Zeca [zeca]; transfer_item para a pessoa, que pode aceitar ou recusar. O motor já levou o jogador até lá (🚶 Rita → (7,4)).',
    );
    expect(performMenuAct(e, { verb: 'gesto', target: 'acena', other: 'mei' }).line).toContain('marque {rita:acena>mei} na narração');
    expect(performMenuAct(e, { verb: 'tocar', target: fixture(e, 'piano').id, other: null }).status).toBe('mestre');
    const segments = parsePlayerInput('{entregar>caneta>zeca}');
    expect(describeInput(e.state, segments, [give.line])).toEqual([give.line]);
  });
});

class Script implements ModelProvider {
  readonly label = 'roteiro';
  messages: string[] = [];
  constructor(private readonly replies: string[]) {}
  startSession(opts: SessionOptions): ModelSession {
    this.messages.push(opts.userMessage);
    const text = this.replies.shift() ?? 'Nada acontece.';
    return {
      step: async (): Promise<StepResult> => ({ text, toolCalls: [], stop: 'end_turn' }),
      addToolResults: () => {},
      addUserText: () => {},
    };
  }
  async verify(): Promise<{ verdict: Verdict }> {
    return { verdict: { consistent: true, issues: [] } };
  }
}

describe('turno com ações do menu', () => {
  it('o motor faz antes do mestre, o mestre recebe o resultado, e o gesto escolhido entra na narração', async () => {
    const e = sala();
    const chair = fixture(e, 'chair');
    const provider = new Script(['Você se senta e acena para Mei.']);
    const gm = new GameMaster({ provider, verify: false });
    const events: { type: string; summary?: string }[] = [];
    await gm.play(e, `{sentar>${chair.id}} {gesto>acena>mei}`, (ev) => events.push(ev as never));
    expect(e.state.characters.rita.seatId).toBe(chair.id);
    expect(events.find((ev) => ev.type === 'tool')?.summary).toContain('Rita');
    expect(provider.messages[0]).toContain('- feito pelo motor (menu): sentar em cadeira');
    expect(provider.messages[0]).toContain('marque {rita:acena>mei} na narração');
    const narration = e.state.log.find((l) => l.kind === 'narration')!;
    expect(narration.text.split('\n')[0]).toBe('{rita:acena>mei}');
  });
});

describe('textos escritos', () => {
  it('a primeira leitura define o texto, vira fato de quem leu, e as outras precisam repetir', async () => {
    const e = sala();
    e.createItem({ name: 'Bilhete', description: 'papel dobrado', holder: { character_id: 'rita' }, text: '' });
    expect(e.state.items.bilhete.text).toBeNull();
    const gm = new GameMaster({ provider: new Script(['Você desdobra o papel.\n@bilhete: "Me encontra no telhado à meia-noite."']), verify: false });
    await gm.play(e, 'Leio o bilhete.', () => {});
    const item = e.state.items.bilhete;
    expect(item.text).toBe('Me encontra no telhado à meia-noite.');
    const fact = e.state.facts.find((f) => f.id === item.textFact)!;
    expect(fact).toMatchObject({ subject: 'bilhete', text: 'Bilhete: «Me encontra no telhado à meia-noite.»', knownBy: ['rita'] });

    expect(analyzeReading(e.state, '@bilhete: Me encontra no porão.').issues).toEqual([expect.stringContaining('já tem escrito «Me encontra no telhado')]);
    expect(analyzeReading(e.state, '@bilhete: …no telhado à meia-noite…').issues).toEqual([]);
    expect(compileBrief(e)).toContain('Bilhete [bilhete] diz «Me encontra no telhado à meia-noite.» (sabem: Rita)');
  });

  it('para ler é preciso estar perto e enxergar', () => {
    const e = sala();
    e.createItem({ name: 'Carta', description: '', holder: { x: 8, y: 2, location_id: 'sala' }, text: 'Volte logo.' });
    expect(analyzeReading(e.state, '@carta: Volte logo.').issues).toEqual([expect.stringMatching(/a 6 tiles de Carta/)]);
    e.moveCharacter({ character_id: 'rita', to: { x: 7, y: 2 } });
    expect(analyzeReading(e.state, '@carta: Volte logo.').issues).toEqual([]);
    e.updateLocation({ location_id: 'sala', light: 0 });
    expect(analyzeReading(e.state, '@carta: Volte logo.').issues).toEqual([expect.stringContaining('não enxerga Carta bem o bastante')]);
  });

  it('quem escreveu sabe; o jogador vê o texto só quando é ele quem lê', () => {
    const e = sala();
    e.createItem({ name: 'Diário', description: '', holder: { character_id: 'mei' }, text: 'Hoje eu vi o zelador no porão.', written_by: 'mei' });
    const fact = e.state.facts.find((f) => f.id === e.state.items.diario.textFact)!;
    expect(fact.knownBy).toEqual(['mei']);
    // Mei lê para si: a jogadora vê só que ela lê.
    expect(playerNarration(e.state, '@diario[>mei]: Hoje eu vi o zelador no porão.')).toBe('@diario[leitura>mei|oculto]: Mei lê diário');
    e.transferItem({ item_id: 'diario', to: { character_id: 'rita' } });
    expect(playerNarration(e.state, '@diario: Hoje eu vi o zelador no porão.')).toBe('@diario[leitura>rita]: Hoje eu vi o zelador no porão.');
    // Leitura que o motor não aceita não mostra o texto.
    expect(playerNarration(e.state, '@diario: Outra coisa.')).toBe('');
  });

  it('o chat mostra a leitura como papel', () => {
    const speaker = (id: string) => (id === 'diario' ? { name: 'Diário', color: '', document: true } : id === 'rita' ? { name: 'Rita', color: '' } : null);
    const html = formatNarration('@diario[leitura>rita]: Hoje eu vi o zelador.', speaker);
    expect(html).toContain('<p class="reading"><b>📜 Diário</b> <span class="speech-mode">lido por Rita</span> <span class="paper">Hoje eu vi o zelador.</span></p>');
  });
});
