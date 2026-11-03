import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { freeAct, type FreeHooks } from '../src/engine/free';
import { nextLine } from '../src/engine/lines';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';
import type { Character } from '../src/engine/types';
import { JevDecider, type NpcDecider } from '../src/gm/decider';
import { GameMaster } from '../src/gm/gm';
import { JevClient, type JevAnswer, type JevQuestion } from '../src/gm/jev';
import type { ModelProvider, ModelSession, SessionOptions, Verdict } from '../src/gm/provider';
import type { InputReader } from '../src/gm/reader';

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

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

/** Jev falso: as respostas vêm de uma função das perguntas, e as perguntas ficam guardadas. */
function fakeJev(answer: (questions: Record<string, JevQuestion>) => Record<string, JevAnswer>) {
  const asked: Record<string, JevQuestion>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const { questions } = JSON.parse(String(init.body)) as { questions: Record<string, JevQuestion> };
    asked.push(questions);
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers: answer(questions), usage: { input_tokens: 500, output_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new JevClient({ apiKey: () => 'k', fetch }), asked };
}
const sim = (p = 0.95): JevAnswer => ({ type: 'noul', noul: p });
const escolhe = (choice: string, p = 0.9): JevAnswer => ({ type: 'choice', choice, confidence: p, probabilities: { [choice]: p } });

describe('o grid livre pergunta a quem decide', () => {
  it('a fala que cabe agora sai, e a do turno dita fora da ordem conta como ouvida', async () => {
    const e = room();
    runTool(e, 'set_lines', { lines: [{ who: 'yuki', turn: lines('A prova é amanhã.', 'O Ren colou, professor.'), general: lines('Gosto de desenhar.') }] });
    const yuki = e.state.characters.yuki;
    const hooks: FreeHooks = { line: async (npc) => npc.lines!.turn[1] };
    const r = await freeAct(e, { kind: 'talk', with: 'yuki' }, hooks);
    expect(r.entries.at(-1)).toBe('@yuki[>kenji]: O Ren colou, professor.');
    expect(yuki.lines!.heard).toBe(1);
    expect(nextLine(yuki)?.text).toBe('A prova é amanhã.');
    // Nenhuma cabe: a conversa fica com o mestre.
    const none = await freeAct(e, { kind: 'talk', with: 'yuki' }, { line: async () => null });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('Yuki não tem nada a dizer agora') });
  });

  it('a iniciativa é de quem o gancho escolher, nunca de quem acabou de falar; ninguém, se não for a hora', async () => {
    const e = room();
    runTool(e, 'set_lines', {
      lines: [
        { who: 'yuki', turn: lines('Professor, posso falar?'), initiative: 'chama' },
        { who: 'ren', turn: lines('Eu não colei!'), initiative: 'chama' },
        { who: 'mei', turn: lines('Professor, um minuto?'), initiative: 'chama' },
      ],
    });
    let offered: Character[] = [];
    const pickRen: FreeHooks = {
      initiative: async (candidates) => {
        offered = candidates;
        return candidates.find((c) => c.id === 'ren') ?? null;
      },
    };
    const pose = (target: string) => ({ kind: 'act' as const, verb: 'pose', target, other: null });
    const r = await freeAct(e, pose('bracos_cruzados'), pickRen);
    expect(r.entries.some((x) => x.startsWith('@ren['))).toBe(true);
    expect(r.entries.some((x) => x.startsWith('@yuki['))).toBe(false);
    expect(offered.map((c) => c.id).sort()).toEqual(['mei', 'ren', 'yuki']);
    // Conversando com a Yuki, ela não é candidata a emendar outra fala; o Ren já disse a dele.
    await freeAct(e, { kind: 'talk', with: 'yuki' }, { initiative: async (candidates) => ((offered = candidates), null) });
    expect(offered.map((c) => c.id)).toEqual(['mei']);
    const quiet = await freeAct(e, pose('pensativo'), { initiative: async () => null });
    expect(quiet.entries.some((x) => x.startsWith('@'))).toBe(false);
  });
});

describe('o Jev decide pelos NPCs', () => {
  it('escolhe a fala, ou nenhuma, e a iniciativa só com chance alta', async () => {
    const e = room();
    runTool(e, 'set_lines', { lines: [{ who: 'yuki', turn: lines('A prova é amanhã.'), general: lines('Gosto de desenhar.'), initiative: 'vem' }] });
    const yuki = e.state.characters.yuki;
    const general = new JevDecider(fakeJev(() => ({ fala: escolhe('f1') })).client);
    expect(await general.line(e, yuki, () => {})).toEqual({ text: 'Gosto de desenhar.' });
    const none = new JevDecider(fakeJev(() => ({ fala: escolhe('nenhuma') })).client);
    expect(await none.line(e, yuki, () => {})).toBeNull();
    const comes = new JevDecider(fakeJev(() => ({ vem_yuki: sim(0.8) })).client);
    expect((await comes.initiative(e, [yuki], ['🚶 Kenji Tanaka → (12,9)'], () => {}))?.id).toBe('yuki');
    const stays = new JevDecider(fakeJev(() => ({ vem_yuki: sim(0.5) })).client);
    expect(await stays.initiative(e, [yuki], [], () => {})).toBeNull();
  });

  it('no turno, a reação e o fato contado saem dos que a pessoa sabe e o jogador não; quem desconversa não conta', async () => {
    const e = room();
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
    runTool(e, 'add_fact', { subject: 'ren', text: 'Ren esqueceu o livro.', known_by: ['ren'] });
    const [cola, livro] = e.state.facts.slice(-2).map((f) => f.id);
    const { client, asked } = fakeJev(() => ({ como: escolhe('coopera'), conta: escolhe(cola) }));
    const r = await new JevDecider(client).react(e, 'Mei, o que houve na prova?', 'mei', () => {});
    expect(r).toMatchObject({ npcId: 'mei', how: 'coopera', fact: { id: cola } });
    expect(Object.keys((asked[0].conta as { criteria: Record<string, string> }).criteria)).not.toContain(livro);
    const dodge = new JevDecider(fakeJev(() => ({ como: escolhe('desconversa'), conta: escolhe(cola) })).client);
    expect(await dodge.react(e, 'Mei, você colou?', 'mei', () => {})).toMatchObject({ how: 'desconversa', fact: null });
  });

  it('o mestre recebe a decisão na mensagem do turno, com o fato já registrado para o jogador', async () => {
    const e = room();
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
    const fact = e.state.facts.at(-1)!;
    const messages: string[] = [];
    const provider: ModelProvider = {
      label: 'falso',
      startSession(opts: SessionOptions): ModelSession {
        messages.push(opts.userMessage);
        return { step: async () => ({ text: '@mei[>kenji]: Eu colei, professor.', toolCalls: [], stop: 'end_turn' }), addToolResults: () => {}, addUserText: () => {} };
      },
      verify: async (): Promise<{ verdict: Verdict }> => ({ verdict: { consistent: true, issues: [] } }),
    };
    const reader: InputReader = { read: async () => ({ plan: null, usages: [], addressee: 'mei' }) };
    const decider: NpcDecider = { hooks: () => ({}), react: async () => ({ npcId: 'mei', how: 'coopera', fact }) };
    await new GameMaster({ provider, reader, decider, verify: false }).play(e, 'Mei, o que houve na prova?', () => {});
    expect(messages[0]).toContain('Decidido pelo motor');
    expect(messages[0]).toContain(`Mei Kato responde de boa vontade e conta ao jogador ${fact.id}`);
    expect(e.knows('kenji', fact)).toBe(true);
  });
});
