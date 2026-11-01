import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { answer } from '../src/engine/free';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';
import { GameMaster, type GmEvent } from '../src/gm/gm';
import { JevClient, type JevAnswer, type JevQuestion } from '../src/gm/jev';
import type { ModelProvider, ModelSession, Verdict } from '../src/gm/provider';
import { JevReader, type InputReader } from '../src/gm/reader';

/** Sala com o professor perto do quadro e três alunos sentados, que ele conhece. */
function room(): GameEngine {
  const e = GameEngine.create('Sou professor numa escola japonesa.', 42);
  e.defineRuleset({ name: 'Escola', attributes: [{ name: 'Carisma', description: '' }], resources: [{ name: 'Energia', max: 10, description: '' }] });
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula.', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata torta', is_player: true, position: { near: 'sala/quadro-1' } });
  for (const name of ['Yuki Sato', 'Ren Ito', 'Mei Kato']) e.createCharacter({ name, role: 'aluno(a)', appearance: 'uniforme', position: { seat: 'random' } });
  runTool(e, 'introduce', { group: ['kenji', 'yuki', 'ren', 'mei'] });
  runTool(e, 'set_lines', { lines: [{ who: 'yuki', turn: [{ text: 'A prova é amanhã, professor.' }], general: [{ text: 'Gosto de desenhar.' }] }] });
  return e;
}

/** Jev falso: as respostas vêm de uma função das perguntas recebidas, e as perguntas ficam guardadas. */
function fakeJev(answer: (questions: Record<string, JevQuestion>) => Record<string, JevAnswer>) {
  const asked: Record<string, JevQuestion>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, JevQuestion> };
    asked.push(questions);
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: answer(questions), usage: { input_tokens: 800, output_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new JevClient({ apiKey: () => 'k', fetch }), asked };
}
const sim = (p = 0.95): JevAnswer => ({ type: 'noul', noul: p });
const escolhe = (choice: string, p = 0.9): JevAnswer => ({ type: 'choice', choice, confidence: p, probabilities: { [choice]: p } });
/** A chave da ação do menu cujo rótulo começa com `label`. */
const actionKey = (q: Record<string, JevQuestion>, label: string) =>
  Object.entries((q.acao as { criteria: Record<string, string> }).criteria).find(([, text]) => text.startsWith(label))![0];

describe('o Jev lê o texto do jogador', () => {
  it('uma ação física do menu, sem fala, vira ação livre', async () => {
    const e = room();
    const { client } = fakeJev((q) => ({ uma: sim(), fala: sim(0.05), acao: escolhe(actionKey(q, 'Ir até — Yuki Sato')) }));
    const r = await new JevReader(client).read(e, 'Vou até a Yuki.');
    expect(r.plan).toMatchObject({ kind: 'act', act: { kind: 'walk', near: 'yuki' } });
    expect(r.usages[0].model).toBe('jev-1.14.0');
  });

  it('uma pergunta a alguém que uma fala pronta responde vira a resposta, com as palavras do jogador', async () => {
    const e = room();
    const { client, asked } = fakeJev(() => ({ uma: sim(), fala: sim(), direto: sim(), com_quem: escolhe('yuki'), resposta_yuki: escolhe('f0') }));
    const r = await new JevReader(client).read(e, 'Yuki, quando é a prova?');
    expect(r.plan).toEqual({ kind: 'line', npcId: 'yuki', line: { text: 'A prova é amanhã, professor.' }, said: 'Yuki, quando é a prova?' });
    // As respostas de cada pessoa com falas prontas vão no mesmo pedido, de antemão.
    expect(Object.keys(asked[0])).toEqual(expect.arrayContaining(['resposta_yuki']));
    expect(Object.keys(asked[0])).not.toContain('resposta_ren');
  });

  it('mais de uma coisa, nenhuma fala que responda, pensamento ou marca: fica com o mestre', async () => {
    const e = room();
    const compound = fakeJev(() => ({ uma: sim(0.3), fala: sim(0.05), acao: escolhe('a0') }));
    expect((await new JevReader(compound.client).read(e, 'Vou até a Yuki e abro a janela.')).plan).toBeNull();
    const noLine = fakeJev(() => ({ uma: sim(), fala: sim(), com_quem: escolhe('yuki'), resposta_yuki: escolhe('nenhuma') }));
    expect((await new JevReader(noLine.client).read(e, 'Yuki, você viu quem colou?')).plan).toBeNull();
    const untouched = fakeJev(() => ({}));
    expect((await new JevReader(untouched.client).read(e, '(Será que a Mei colou?)')).plan).toBeNull();
    expect((await new JevReader(untouched.client).read(e, 'Olho {sentar>sala/carteira-1}')).plan).toBeNull();
    expect(untouched.asked).toHaveLength(0);
    expect((await new JevReader(new JevClient({ apiKey: () => undefined })).read(e, 'Vou até a Yuki.')).plan).toBeNull();
  });
});

describe('a resposta no grid', () => {
  it('o jogador chega perto, diz o que escreveu, e quem responde fala a linha escolhida', async () => {
    const e = room();
    const line = e.state.characters.yuki.lines!.turn[0];
    const r = await answer(e, 'yuki', line, 'Yuki, quando é a prova?');
    expect(r.ok).toBe(true);
    expect(r.entries.filter((x) => x.startsWith('@'))).toEqual(['@kenji[>yuki]: Yuki, quando é a prova?', '@yuki[>kenji]: A prova é amanhã, professor.']);
    // Respondeu com a próxima fala do turno: a conversa anda.
    expect(e.state.characters.yuki.lines!.heard).toBe(1);
  });
});

describe('o turno com o leitor', () => {
  /** Provedor que só conta as sessões: o mestre não deve ser chamado quando o grid resolve. */
  class CountingProvider implements ModelProvider {
    readonly label = 'contador';
    sessions = 0;
    startSession(): ModelSession {
      this.sessions++;
      return { step: async () => ({ text: 'O mestre narra.', toolCalls: [], stop: 'end_turn' }), addToolResults: () => {}, addUserText: () => {} };
    }
    async verify(): Promise<{ verdict: Verdict }> {
      return { verdict: { consistent: true, issues: [] } };
    }
  }

  it('resolvido no grid, não chama o mestre nem gasta um turno; sem plano, o mestre narra', async () => {
    const e = room();
    const turn = e.state.turn;
    const provider = new CountingProvider();
    const walk: InputReader = { read: async () => ({ plan: { kind: 'act', act: { kind: 'walk', near: 'yuki' }, label: 'Ir até — Yuki Sato' }, usages: [] }) };
    const events: GmEvent[] = [];
    await new GameMaster({ provider, reader: walk, verify: false }).play(e, 'Vou até a Yuki.', (ev) => events.push(ev));
    expect(provider.sessions).toBe(0);
    expect(e.state.turn).toBe(turn);
    expect(events.find((ev) => ev.type === 'free')).toMatchObject({ entries: [expect.stringContaining('Kenji Tanaka →')] });
    const none: InputReader = { read: async () => ({ plan: null, usages: [] }) };
    await new GameMaster({ provider, reader: none, verify: false }).play(e, 'Conto uma piada para a turma.', () => {});
    expect(provider.sessions).toBe(1);
  });
});
