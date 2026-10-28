import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';
import { GameMaster, type GmEvent } from '../src/gm/gm';
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
  async verify(prompt: string): Promise<Verdict> {
    this.verifyPrompts.push(prompt);
    return this.verdicts.shift() ?? { consistent: true, issues: [] };
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
    expect(events.filter((e) => e.type === 'narration_reset')).toHaveLength(1);
    expect(events.find((e) => e.type === 'narration')).toMatchObject({ text: 'A sala 1-A cheira a giz e café requentado.' });
    expect(provider.options[0].effort).toBe('medium');
    expect(provider.verifyPrompts[0]).toContain('<narracao>\nA sala 1-A cheira a giz');
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
      { type: 'narration', text: 'Você escreve 28/10 no quadro, e o giz range.', turn: 1 },
    ]);
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
