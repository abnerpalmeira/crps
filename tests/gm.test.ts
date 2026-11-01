import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';
import { GameMaster, dropPreamble, splitOptions, type GmEvent } from '../src/gm/gm';
import { OPTIONS_REQUEST, SYSTEM_PROMPT, turnMessage, verifierPrompt } from '../src/gm/prompts';
import { compileBrief } from '../src/engine/brief';
import type { CheckInput, Checker } from '../src/gm/checker';
import type { ModelProvider, ModelSession, SessionOptions, StepHandlers, StepResult, Verdict } from '../src/gm/provider';

/** Provedor roteirizado: cada sessão (turno) consome uma lista de respostas do "modelo". */
class FakeSession implements ModelSession {
  toolResults: { id: string; content: string; isError: boolean }[] = [];
  userTexts: string[] = [];
  constructor(private readonly steps: StepResult[]) {}
  async step(handlers?: StepHandlers): Promise<StepResult> {
    const next = this.steps.shift();
    if (!next) throw new Error('roteiro acabou');
    if (next.text) handlers?.onText?.(next.text);
    return next;
  }
  addToolResults(results: { id: string; content: string; isError: boolean }[]): void {
    this.toolResults.push(...results);
  }
  addUserText(text: string): void {
    this.userTexts.push(text);
  }
}

class FakeProvider implements ModelProvider {
  readonly label = 'fake';
  sessions: FakeSession[] = [];
  options: SessionOptions[] = [];
  verifyPrompts: string[] = [];
  constructor(
    private readonly script: StepResult[][],
    private readonly verdicts: Verdict[] = [],
  ) {}
  startSession(opts: SessionOptions): ModelSession {
    const session = new FakeSession(this.script.shift() ?? []);
    this.sessions.push(session);
    this.options.push(opts);
    return session;
  }
  async verify(prompt: string): Promise<{ verdict: Verdict }> {
    this.verifyPrompts.push(prompt);
    return { verdict: this.verdicts.shift() ?? { consistent: true, issues: [] } };
  }
}

const call = (id: string, name: string, input: unknown) => ({ id, name, input });
const tools = (...toolCalls: ReturnType<typeof call>[]): StepResult => ({ text: '', toolCalls, stop: 'tool_use' });
const say = (text: string): StepResult => ({ text, toolCalls: [], stop: 'end_turn' });

function worldBuildingSteps(): StepResult[] {
  return [
    {
      text: 'Vou montar a sala.',
      stop: 'tool_use',
      toolCalls: [
        call('t1', 'define_ruleset', {
          name: 'Escola',
          attributes: [
            { name: 'Paciência', description: 'calma' },
            { name: 'Carisma', description: 'presença' },
          ],
          resources: [{ name: 'Energia', max: 10, description: 'fôlego' }],
        }),
        call('t2', 'create_location', { id: 'sala', name: 'Sala 1-A', description: 'Sala japonesa.', layout: EXAMPLE_CLASSROOM }),
      ],
    },
    tools(
      call('t3', 'create_characters', {
        characters: [
          { name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata torta', is_player: true, position: { near: 'sala/quadro-1' } },
          { name: 'Yuki Sato', role: 'aluna', appearance: 'tranças', position: { seat: 'random' } },
          { name: 'Ren Ito', role: 'aluno', appearance: 'boné escondido', position: { seat: 'random' } },
        ],
      }),
      call('t4', 'create_items', { items: [{ name: 'Giz', description: 'giz branco', holder: { character_id: 'kenji' } }] }),
    ),
    say('A sala 1-A cheira a giz e café requentado.'),
  ];
}

async function setUpWorld(provider: FakeProvider, gm: GameMaster) {
  const engine = GameEngine.create('Sou professor numa escola japonesa.', 1);
  const events: GmEvent[] = [];
  await gm.setup(engine, (e) => events.push(e));
  return { engine, events };
}

describe('GameMaster', () => {
  it('monta o mundo pelas tools e só aceita como narração o texto final', async () => {
    const provider = new FakeProvider([worldBuildingSteps()]);
    const { engine, events } = await setUpWorld(provider, new GameMaster({ provider }));

    expect(engine.player?.name).toBe('Kenji Tanaka');
    expect(engine.itemsHeldBy('kenji').map((i) => i.name)).toEqual(['Giz']);
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(4);
    expect(events.filter((e) => e.type === 'narration')).toHaveLength(1);
    expect(events.find((e) => e.type === 'narration')).toMatchObject({ text: 'A sala 1-A cheira a giz e café requentado.' });
    expect(provider.options[0].effort).toBe('medium');
    expect(provider.verifyPrompts[0]).toContain('<narracao>\nA sala 1-A cheira a giz');
    expect(provider.verifyPrompts[0]).toContain('vazamento de conhecimento');
    expect(engine.state.log.at(-1)).toMatchObject({ kind: 'narration' });
  });

  it('pede correção quando o verificador acha narração sem mudança de estado', async () => {
    const provider = new FakeProvider(
      [
        worldBuildingSteps(),
        [
          say('Você escreve a data no quadro.'),
          tools(call('t5', 'update_fixture', { fixture_id: 'sala/quadro-1', text: '28/10' })),
          say('Você escreve 28/10 no quadro, e o giz range.'),
        ],
      ],
      [{ consistent: true, issues: [] }, { consistent: false, issues: ['Escrita no quadro sem update_fixture.'] }],
    );
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    const events: GmEvent[] = [];
    await gm.play(engine, 'Escrevo a data no quadro.', (e) => events.push(e));

    expect(engine.findFixture('sala/quadro-1').text).toBe('28/10');
    expect(provider.sessions[1].userTexts[0]).toContain('Escrita no quadro sem update_fixture.');
    expect(provider.options[1].effort).toBe('low');
    expect(provider.options[1].userMessage).toContain('Ação do jogador:\n"""\nEscrevo a data no quadro.');
    expect(events.find((e) => e.type === 'verify')).toMatchObject({ consistent: false });
    expect(events.filter((e) => e.type === 'narration')).toEqual([
      { type: 'narration', text: 'Você escreve 28/10 no quadro, e o giz range.', turn: 1, options: [] },
    ]);
  });

  it('a conferência recebe o mundo de antes do turno e a narração crua, e o problema dela pede correção', async () => {
    const provider = new FakeProvider([worldBuildingSteps(), [say('Você vai até a janela.\n>> Olho para fora.'), say('Você vai até a janela e olha o pátio.')]]);
    const seen: CheckInput[] = [];
    const verdicts: Verdict[] = [
      { consistent: true, issues: [] },
      { consistent: false, issues: ['O jogador anda sem move_character.'] },
    ];
    const checker: Checker = {
      check: async (input) => {
        seen.push(input);
        return { verdict: verdicts.shift() ?? null, usages: [] };
      },
    };
    const gm = new GameMaster({ provider, checker });
    const { engine } = await setUpWorld(provider, gm);
    const where = { ...engine.player!.pos! };
    await gm.play(engine, 'Vou até a janela.', () => {});

    expect(seen[1].before.characters.kenji.pos).toEqual(where);
    expect(seen[1].narration).toBe('Você vai até a janela.\n>> Olho para fora.');
    expect(provider.sessions[1].userTexts[0]).toContain('O jogador anda sem move_character.');
    expect(provider.verifyPrompts).toHaveLength(0);
  });

  it('a narração corrigida chega ao jogador sem o recado sobre a correção', async () => {
    const provider = new FakeProvider(
      [
        worldBuildingSteps(),
        [
          say('Você escreve a data no quadro.'),
          tools(call('t5', 'update_fixture', { fixture_id: 'sala/quadro-1', text: '28/10' })),
          say('O quadro agora tem a data. Segue a narração corrigida deste turno.\n\nVocê escreve 28/10 no quadro, e o giz range.'),
        ],
      ],
      [{ consistent: true, issues: [] }, { consistent: false, issues: ['Escrita no quadro sem update_fixture.'] }],
    );
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    const events: GmEvent[] = [];
    await gm.play(engine, 'Escrevo a data no quadro.', (e) => events.push(e));

    expect(provider.sessions[1].userTexts[0]).toContain('comece direto pela história');
    expect(events.filter((e) => e.type === 'narration')).toEqual([
      { type: 'narration', text: 'Você escreve 28/10 no quadro, e o giz range.', turn: 1, options: [] },
    ]);
    // Parágrafo de história fica, mesmo sem recado nenhum antes dele.
    expect(dropPreamble('Lúcia se vira.\n\nO vento sobe.')).toBe('Lúcia se vira.\n\nO vento sobe.');
  });

  it('a narração chega inteira, depois do verificador, e as três ações saem dela para os botões e o log', async () => {
    const provider = new FakeProvider([
      worldBuildingSteps(),
      [say('Você escreve 28/10 no quadro.\n>> Começo a chamada.\n>> "Bom dia, turma."\n>> Vou até a janela.')],
    ]);
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    const events: GmEvent[] = [];
    await gm.play(engine, 'Escrevo a data no quadro.', (e) => events.push(e));

    const options = ['Começo a chamada.', '"Bom dia, turma."', 'Vou até a janela.'];
    expect(events.filter((e) => e.type === 'narration')).toEqual([{ type: 'narration', text: 'Você escreve 28/10 no quadro.', turn: 1, options }]);
    expect(engine.state.log.at(-1)).toMatchObject({ kind: 'narration', text: 'Você escreve 28/10 no quadro.', options });
    // O verificador vê as ações, para apontar nome ou fato que o jogador não sabe.
    expect(provider.verifyPrompts[1]).toContain('>> Vou até a janela.');
    const types = events.map((e) => e.type);
    expect(types.indexOf('narration')).toBeGreaterThan(types.indexOf('verify'));
    expect(events).toContainEqual({ type: 'status', text: 'Conferindo a narração…' });
  });

  it('narração sem as ações: o mestre é chamado de novo só para elas, e a narração fica', async () => {
    const provider = new FakeProvider([
      worldBuildingSteps(),
      [say('Você escreve 28/10 no quadro.'), say('>> 1. Começo a chamada.\n> 2. Vou até a janela.\n>> Sento e espero.\n>> Saio da sala.')],
    ]);
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    const events: GmEvent[] = [];
    await gm.play(engine, 'Escrevo a data no quadro.', (e) => events.push(e));

    expect(provider.sessions[1].userTexts).toEqual([OPTIONS_REQUEST]);
    expect(events.find((e) => e.type === 'narration')).toEqual({
      type: 'narration',
      text: 'Você escreve 28/10 no quadro.',
      turn: 1,
      options: ['Começo a chamada.', 'Vou até a janela.', 'Sento e espero.'],
    });
    // Se nem o pedido trouxer as ações (a criação aqui não tem mais roteiro), o turno segue sem elas.
    expect(engine.state.log.find((e) => e.kind === 'narration' && e.turn === 0)?.options).toBeUndefined();
    expect(splitOptions('Chove.\n\n>> Corro.')).toEqual({ narration: 'Chove.', options: ['Corro.'] });
  });

  it('o prompt do mestre sai do mundo: na criação, sem a época; nos turnos, com a dela', async () => {
    const provider = new FakeProvider([worldBuildingSteps(), [say('A turma se ajeita.')]]);
    const gm = new GameMaster({ provider, system: (world, setup) => (setup ? 'CRIAÇÃO' : `TURNO ${world.era ?? 'sem época'}`) });
    const { engine } = await setUpWorld(provider, gm);
    engine.state.era = 'atual';
    await gm.play(engine, 'Olho a turma.', () => {});
    expect(provider.options.map((o) => o.system)).toEqual(['CRIAÇÃO', 'TURNO atual']);
  });

  it('o prompt manda os NPCs agirem e os lugares novos terem as saídas que teriam', () => {
    expect(SYSTEM_PROMPT).toContain('# Os outros agem');
    expect(SYSTEM_PROMPT).toContain('Ameaça de NPC vira ação');
    expect(SYSTEM_PROMPT).toContain('Lugar novo nasce com as saídas que teria');
  });

  it('o mestre vê o que cada NPC quer, é lembrado de fazê-los agir e o verificador cobra a passividade', () => {
    const e = GameEngine.create('teste', 3);
    e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
    e.createCharacter({ name: 'Rita', role: 'aluna', appearance: '', is_player: true, location_id: 'sala', position: { x: 2, y: 2 } });
    e.createCharacter({ name: 'Abel', role: 'inspetor', appearance: '', location_id: 'sala', position: { x: 4, y: 2 } });
    e.updateCharacter({ character_id: 'abel', personality: 'Rígido e cansado.', goals: 'Manter a ordem até o sinal.' });
    const brief = compileBrief(e, { recentTurns: 0 });
    // O jeito do NPC guia como ele reage; o do personagem do jogador fica com o jogador.
    expect(brief).toContain('jeito: "Rígido e cansado."');
    expect(brief).toContain('quer: "Manter a ordem até o sinal."');
    expect(SYSTEM_PROMPT).toContain('Cada um reage como ele mesmo');
    expect(turnMessage(brief, 'Saio correndo da sala.')).toContain('quem ameaçou cumpre se o jogador insistiu');
    expect(verifierPrompt({ state: brief, changes: [], input: '', narration: '' })).toContain('passividade: o jogador agride alguém, foge');
    expect(SYSTEM_PROMPT).toContain('não assiste parado a uma agressão');
  });

  it('desfaz o turno inteiro quando a API falha no meio', async () => {
    const provider = new FakeProvider([worldBuildingSteps(), [tools(call('t7', 'update_fixture', { fixture_id: 'sala/quadro-1', text: 'meio turno' }))]]);
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    const before = engine.toJSON();
    await expect(gm.play(engine, 'Escrevo no quadro.', () => {})).rejects.toThrow('roteiro acabou');
    expect(engine.toJSON()).toBe(before);
  });

  it('devolve erros de tool ao modelo e não verifica recusas', async () => {
    const provider = new FakeProvider([
      worldBuildingSteps(),
      [tools(call('t6', 'move_character', { character_id: 5 })), say('Você hesita.')],
      [{ text: '', toolCalls: [], stop: 'refusal' }],
    ]);
    const gm = new GameMaster({ provider });
    const { engine } = await setUpWorld(provider, gm);
    await gm.play(engine, 'Ando.', () => {});
    expect(provider.sessions[1].toolResults[0]).toMatchObject({ id: 't6', isError: true });
    expect(provider.sessions[1].toolResults[0].content).toMatch(/^Entrada inválida/);

    const verifiesBefore = provider.verifyPrompts.length;
    const events: GmEvent[] = [];
    await gm.play(engine, 'Algo proibido.', (e) => events.push(e));
    expect(provider.verifyPrompts).toHaveLength(verifiesBefore);
    expect(events.find((e) => e.type === 'narration')).toMatchObject({ text: expect.stringContaining('não consegue narrar') });
  });
});
