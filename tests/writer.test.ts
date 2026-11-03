import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { distanceBetween } from '../src/engine/perception';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';
import type { Checker } from '../src/gm/checker';
import type { NpcDecider } from '../src/gm/decider';
import { GameMaster, type GmEvent } from '../src/gm/gm';
import { JevClient, type JevAnswer, type JevQuestion } from '../src/gm/jev';
import type { ModelProvider, ModelSession, Verdict, WriteOptions, WriteResult } from '../src/gm/provider';
import { JevReader, type InputReader } from '../src/gm/reader';
import { writingCalls, writtenText, type Writing } from '../src/gm/writer';

/** Sala com o professor perto do quadro e três alunos sentados, que ele conhece. */
function room(): GameEngine {
  const e = GameEngine.create('Sou professor numa escola japonesa.', 42);
  e.defineRuleset({ name: 'Escola', attributes: [{ name: 'Carisma', description: '' }], resources: [{ name: 'Energia', max: 10, description: '' }] });
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula.', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata torta', is_player: true, position: { near: 'sala/quadro-1' } });
  for (const name of ['Yuki Sato', 'Ren Ito', 'Mei Kato']) e.createCharacter({ name, role: 'aluno(a)', appearance: 'uniforme', position: { seat: 'random' } });
  runTool(e, 'introduce', { group: ['kenji', 'yuki', 'ren', 'mei'] });
  return e;
}

/** Jev falso: as respostas vêm de uma função das perguntas recebidas. */
function fakeJev(answer: (questions: Record<string, JevQuestion>) => Record<string, JevAnswer>) {
  const fetch = (async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, JevQuestion> };
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: answer(questions), usage: { input_tokens: 800, output_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return new JevClient({ apiKey: () => 'k', fetch });
}
const sim = (p = 0.95): JevAnswer => ({ type: 'noul', noul: p });
const escolhe = (choice: string, p = 0.9): JevAnswer => ({ type: 'choice', choice, confidence: p, probabilities: { [choice]: p } });

/** A resposta do escritor, com o que cada teste muda. */
const writing = (over: Partial<Writing> = {}): Writing => ({
  narracao: 'Mei abaixa os olhos.\n@mei[>kenji]: Eu colei, professor.',
  acoes: ['"Por que, Mei?"', 'Volto para o quadro.', 'Chamo a Yuki.'],
  fatos: [],
  contados: [],
  apresentados: [],
  sentimentos: [],
  pensamentos: [],
  falas: [],
  minutos: 2,
  ...over,
});
const line = (texto: string, cochicho = false) => ({ texto, fato: null, diz_o_nome: false, cochicho });

/** Provedor com escritor: cada chamada consome uma resposta (null: fora do esquema); o mestre narra numa sessão. */
class WritingProvider implements ModelProvider {
  readonly label = 'escritor';
  sessions = 0;
  prompts: string[] = [];
  constructor(private readonly outputs: (Writing | null)[]) {}
  startSession(): ModelSession {
    this.sessions++;
    return { step: async () => ({ text: 'O mestre narra.\n>> Um\n>> Dois\n>> Três', toolCalls: [], stop: 'end_turn' }), addToolResults: () => {}, addUserText: () => {} };
  }
  async verify(): Promise<{ verdict: Verdict }> {
    return { verdict: { consistent: true, issues: [] } };
  }
  async write(opts: WriteOptions): Promise<WriteResult> {
    this.prompts.push(opts.prompt);
    return { data: this.outputs.shift() ?? null };
  }
}

/** O leitor diz que o jogador conversa com a Mei (só conversa, se `talk`), e o decisor faz a Mei contar o que fez. */
function talkWithMei(e: GameEngine, talk = true) {
  runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
  const fact = e.state.facts.at(-1)!;
  const reader: InputReader = { read: async () => ({ plan: null, usages: [], addressee: 'mei', talk }) };
  const decider: NpcDecider = { hooks: () => ({}), react: async () => ({ npcId: 'mei', how: 'coopera', fact }) };
  return { reader, decider, fact };
}

describe('o que o escritor muda vira chamadas das tools', () => {
  it('na ordem do motor, sem o que é do jogador, e cortado no tamanho que as tools aceitam', () => {
    const calls = writingCalls(
      writing({
        fatos: [
          { assunto: 'mei', texto: 'Mei tem medo de ser expulsa.', sabem: ['mei', 'kenji'] },
          { assunto: 'mei', texto: ' ', sabem: [] },
        ],
        contados: [
          { fato: 'f1', para: ['yuki'], de: 'mei' },
          { fato: 'f1', para: [], de: null },
        ],
        apresentados: [{ quem: 'mei', para: ['kenji'] }],
        sentimentos: [
          { quem: 'mei', por_quem: 'kenji', grau: 5, texto: 'Confia no professor.' },
          { quem: 'kenji', por_quem: 'mei', grau: 1, texto: 'Pena dela.' },
        ],
        pensamentos: [
          { quem: 'kenji', texto: 'Preciso falar com o diretor.' },
          { quem: 'mei', texto: 'Quer sair da sala.' },
        ],
        falas: [{ quem: 'mei', do_turno: ['a', 'b', 'c', 'd', 'e'].map((t) => line(t)), gerais: [], iniciativa: 'vem' }],
        minutos: 900,
      }),
      'kenji',
    );
    expect(calls.map((c) => c.name)).toEqual(['add_fact', 'share_knowledge', 'introduce', 'set_feelings', 'update_character', 'set_lines', 'advance_time']);
    const input = (name: string) => calls.find((c) => c.name === name)!.input;
    expect(input('share_knowledge')).toEqual({ fact_id: 'f1', to: ['yuki'], from: 'mei', how: 'na conversa' });
    expect(input('introduce')).toEqual({ who: ['kenji'], knows: ['mei'], mutual: false });
    expect(input('set_feelings')).toEqual({ feelings: [{ who: 'mei', toward: 'kenji', degree: 3, text: 'Confia no professor.' }] });
    expect(input('update_character')).toEqual({ character_id: 'mei', thoughts: 'Quer sair da sala.' });
    expect(input('set_lines')).toEqual({ lines: [{ who: 'mei', turn: ['a', 'b', 'c', 'd'].map((text) => ({ text })), initiative: 'vem' }] });
    expect(input('advance_time')).toEqual({ minutes: 240, reason: 'a conversa' });
  });

  it('a narração leva as ações no fim, como o mestre escreve', () => {
    expect(writtenText(writing({ acoes: ['>> "Por que, Mei?"', ' Volto para o quadro. ', '', 'Chamo a Yuki.', 'Saio.'] }))).toBe(
      'Mei abaixa os olhos.\n@mei[>kenji]: Eu colei, professor.\n\n>> "Por que, Mei?"\n>> Volto para o quadro.\n>> Chamo a Yuki.',
    );
  });
});

describe('o leitor marca a conversa que pode ir ao escritor', () => {
  it('só falar com alguém vai; pedir algo físico ou agir junto, não', async () => {
    const e = room();
    const reader = (extra: Record<string, JevAnswer>) =>
      new JevReader(fakeJev(() => ({ uma: sim(), fala: sim(), com_quem: escolhe('yuki'), acao: escolhe('nenhuma'), fisico: sim(0.05), pede_algo: sim(0.05), ...extra })));
    expect(await reader({}).read(e, 'Yuki, você viu quem colou?')).toMatchObject({ plan: null, addressee: 'yuki', talk: true });
    expect(await reader({ pede_algo: sim() }).read(e, 'Yuki, me traz o caderno.')).toMatchObject({ addressee: 'yuki', talk: false });
    expect(await reader({ fisico: sim(0.5) }).read(e, 'Seguro o braço da Yuki e pergunto.')).toMatchObject({ addressee: 'yuki', talk: false });
  });

  it('o Jev sabe ao lado de que móvel cada um está, e ir até esse móvel é ir até a pessoa', async () => {
    const e = room();
    runTool(e, 'move_character', { character_id: 'yuki', to: { near: 'sala/mesa-prof-1' } });
    let asked: Record<string, JevQuestion> = {};
    const desk = (q: Record<string, JevQuestion>) =>
      Object.entries((q.acao as { criteria: Record<string, string> }).criteria).find(([, text]) => text.startsWith('Ir até') && text.includes('(mesa-prof-1)'))![0];
    const client = fakeJev((q) => {
      asked = q;
      return { uma: sim(), fala: sim(), com_quem: escolhe('yuki'), acao: escolhe(desk(q)), fisico: sim(0.05), pede_algo: sim(0.05) };
    });
    const r = await new JevReader(client).read(e, 'Vou até a mesa do professor e pergunto à Yuki se ela fez a lição.');
    expect((asked.com_quem as { criteria: Record<string, string> }).criteria.yuki).toMatch(/^Yuki Sato, ao lado de: .*mesa do professor \(mesa-prof-1\)/);
    expect(r).toMatchObject({ plan: null, addressee: 'yuki', talk: true });
    // Sem confiança em com quem, vale a mais provável só se o jogador vai até essa pessoa.
    const unsure = (target: string) =>
      new JevReader(fakeJev((q) => ({ uma: sim(), fala: sim(), com_quem: escolhe(target, 0.3), acao: escolhe(desk(q)), fisico: sim(0.05), pede_algo: sim(0.05) })));
    expect(await unsure('yuki').read(e, 'Chego na mesa do professor e pergunto: "Fez a lição?"')).toMatchObject({ addressee: 'yuki', talk: true });
    expect((await unsure('ren').read(e, 'Chego na mesa do professor e pergunto: "Fez a lição?"')).addressee).toBeUndefined();
  });
});

describe('o turno de conversa pelo escritor', () => {
  it('uma chamada sem tools: o motor leva o jogador até a pessoa e aplica o que mudou, sem o mestre', async () => {
    const e = room();
    const { reader, decider, fact } = talkWithMei(e);
    const provider = new WritingProvider([
      writing({
        fatos: [{ assunto: 'mei', texto: 'Mei tem medo de ser expulsa.', sabem: ['mei', 'kenji'] }],
        sentimentos: [{ quem: 'mei', por_quem: 'kenji', grau: 2, texto: 'Confia no professor.' }],
        falas: [{ quem: 'mei', do_turno: [line('Não conta pro diretor, por favor.', true)], gerais: [], iniciativa: 'nenhuma' }],
      }),
    ]);
    const events: GmEvent[] = [];
    const turn = e.state.turn;
    await new GameMaster({ provider, reader, decider, verify: false }).play(e, 'Mei, o que houve na prova?', (ev) => events.push(ev));
    expect(provider.sessions).toBe(0);
    expect(provider.prompts[0]).toContain(`Mei Kato responde de boa vontade e conta ao jogador ${fact.id}`);
    // A Mei estava a 7 tiles: o motor leva o professor até ela, e o escritor sabe disso.
    expect(distanceBetween(e.state, 'kenji', 'mei')).toBeLessThanOrEqual(2);
    expect(provider.prompts[0]).toContain('O personagem do jogador vai até Mei Kato para falar');
    expect(e.state.turn).toBe(turn + 1);
    // O turno do mestre levou o professor sem gastar passos, e o turno do jogador começa com todos.
    expect(e.state.characters.kenji.steps).toEqual({ max: 8, used: 0 });
    expect(e.state.facts.map((f) => f.text)).toContain('Mei tem medo de ser expulsa.');
    expect(e.state.characters.mei.lines?.turn).toMatchObject([{ text: 'Não conta pro diretor, por favor.', whisper: true }]);
    expect(events.find((ev) => ev.type === 'narration')).toMatchObject({ options: ['"Por que, Mei?"', 'Volto para o quadro.', 'Chamo a Yuki.'] });
  });

  it('sem resposta válida do escritor, ou se o jogador não só conversa, o mestre narra', async () => {
    const e = room();
    const { reader, decider } = talkWithMei(e);
    const provider = new WritingProvider([null]);
    const events: GmEvent[] = [];
    await new GameMaster({ provider, reader, decider, verify: false }).play(e, 'Mei, o que houve na prova?', (ev) => events.push(ev));
    expect(provider.prompts).toHaveLength(1);
    expect(provider.sessions).toBe(1);
    expect(events.find((ev) => ev.type === 'narration')).toMatchObject({ text: 'O mestre narra.' });
    const other = room();
    const acting = talkWithMei(other, false);
    const unused = new WritingProvider([writing()]);
    await new GameMaster({ provider: unused, reader: acting.reader, decider: acting.decider, verify: false }).play(other, 'Seguro a Mei pelo braço.', () => {});
    expect(unused.prompts).toHaveLength(0);
    expect(unused.sessions).toBe(1);
  });

  it('a conferência e as recusas do motor voltam ao escritor, e a reescrita substitui a primeira resposta inteira', async () => {
    const e = room();
    const { reader, decider } = talkWithMei(e);
    const provider = new WritingProvider([
      writing({
        narracao: 'Mei olha para a porta.\n@mei[>kenji]: Foi a diretora que mandou.',
        fatos: [{ assunto: 'mei', texto: 'A diretora mandou Mei colar.', sabem: ['mei', 'kenji'] }],
        sentimentos: [{ quem: 'fantasma', por_quem: 'kenji', grau: 1, texto: 'Ninguém.' }],
      }),
      writing({ fatos: [{ assunto: 'mei', texto: 'Mei tem medo de ser expulsa.', sabem: ['mei', 'kenji'] }] }),
    ]);
    const checker: Checker = { check: async () => ({ verdict: { consistent: false, issues: ['Mei culpa a diretora sem nada registrado sobre isso.'] }, usages: [] }) };
    const events: GmEvent[] = [];
    await new GameMaster({ provider, reader, decider, checker }).play(e, 'Mei, o que houve na prova?', (ev) => events.push(ev));
    expect(provider.prompts).toHaveLength(2);
    expect(provider.prompts[1]).toContain('Mei culpa a diretora sem nada registrado sobre isso.');
    expect(provider.prompts[1]).toContain('Em sentimentos, o motor recusou');
    expect(provider.prompts[1]).toContain('"A diretora mandou Mei colar."');
    const facts = e.state.facts.map((f) => f.text);
    expect(facts).toContain('Mei tem medo de ser expulsa.');
    expect(facts).not.toContain('A diretora mandou Mei colar.');
    expect(events.filter((ev) => ev.type === 'narration')).toEqual([expect.objectContaining({ text: expect.stringContaining('Eu colei, professor.') })]);
  });
});
