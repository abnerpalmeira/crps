import { describe, expect, it } from 'vitest';
import { dropRepeated, nameLeaks, repeats } from '../src/engine/checks';
import { worldDiff } from '../src/engine/diff';
import { GameEngine } from '../src/engine/engine';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';
import type { WorldState } from '../src/engine/types';
import { JevChecker, LlmChecker, ShadowChecker, planCheck, type CheckInput, type Checker, type ShadowEntry } from '../src/gm/checker';
import { JevClient, type JevAnswer, type JevQuestion } from '../src/gm/jev';
import type { ModelProvider, Verdict } from '../src/gm/provider';
import { checkerFor } from '../src/gm/runtime';

/** Sala com o professor perto do quadro e três alunos sentados; por padrão ele conhece a turma. */
function room(knowsClass = true): GameEngine {
  const e = GameEngine.create('Sou professor numa escola japonesa.', 42);
  e.defineRuleset({ name: 'Escola', attributes: [{ name: 'Carisma', description: '' }], resources: [{ name: 'Energia', max: 10, description: '' }] });
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula.', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata torta', is_player: true, position: { near: 'sala/quadro-1' } });
  for (const name of ['Yuki Sato', 'Ren Ito', 'Mei Kato']) e.createCharacter({ name, role: 'aluno(a)', appearance: 'uniforme', position: { seat: 'random' } });
  if (knowsClass) runTool(e, 'introduce', { group: ['kenji', 'yuki', 'ren', 'mei'] });
  return e;
}

const snapshot = (e: GameEngine) => JSON.parse(e.toJSON()) as WorldState;
const turn = (e: GameEngine, before: WorldState, narration: string, action = 'Olho a turma.'): CheckInput => ({ engine: e, before, changes: [], input: action, narration });

/** Jev falso: responde o que o teste mandar e guarda as perguntas que recebeu. */
function fakeJev(answers: Record<string, JevAnswer>) {
  const asked: Record<string, JevQuestion>[] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    asked.push((JSON.parse(String(init.body)) as { questions: Record<string, JevQuestion> }).questions);
    return new Response(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 1000, output_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { client: new JevClient({ apiKey: () => 'k', fetch }), asked };
}
const sim = (p = 0.95): JevAnswer => ({ type: 'noul', noul: p });
const escolhe = (choice: string, p = 0.9): JevAnswer => ({ type: 'choice', choice, confidence: p, probabilities: { [choice]: p, nenhum: 1 - p } });

/** Verificador que devolve sempre o mesmo veredito, como se fosse o modelo. */
class FixedChecker implements Checker {
  constructor(private readonly verdict: Verdict) {}
  async check() {
    return { verdict: this.verdict, usages: [{ model: 'claude-haiku-5-5', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }] };
  }
}

describe('o que o turno mudou', () => {
  it('worldDiff vê quem andou, o item que surgiu, quem soube, o relógio, o sentimento e quem nasceu', () => {
    const e = room();
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
    const fact = e.state.facts.at(-1)!.id;
    const before = snapshot(e);
    runTool(e, 'move_character', { character_id: 'ren', to: { near: 'kenji' } });
    runTool(e, 'create_items', { items: [{ id: 'giz', name: 'Giz', description: 'branco', holder: { character_id: 'kenji' } }] });
    runTool(e, 'share_knowledge', { fact_id: fact, to: ['kenji'], from: 'mei', how: 'ela contou' });
    runTool(e, 'advance_time', { minutes: 60, reason: 'a aula passa' });
    runTool(e, 'set_feelings', { feelings: [{ who: 'yuki', toward: 'kenji', degree: 2, text: 'admira o professor' }] });
    e.createCharacter({ name: 'Aiko Ito', role: 'inspetora', appearance: 'crachá', position: { near: 'kenji' } });
    const d = worldDiff(before, e.state);
    expect([...d.moved].sort()).toEqual(['aiko', 'ren']);
    expect(d.createdItems.has('giz') && d.items.has('giz')).toBe(true);
    expect(d.learned.get(fact)).toEqual(['kenji']);
    expect(d.minutes).toBe(60);
    expect(d.feelings.has('yuki>kenji')).toBe(true);
    expect([...d.created]).toEqual(['aiko']);
  });
});

describe('checagens do código', () => {
  it('acha o nome de quem o jogador não conhece na prosa, nas falas e nas ações sugeridas, mas não no prefixo das falas', () => {
    const e = room(false);
    expect(nameLeaks(e.state, '@yuki: Bom dia.')).toEqual([]);
    expect(nameLeaks(e.state, 'Yuki Sato levanta a mão.').map((l) => l.name)).toEqual(['Yuki Sato']);
    expect(nameLeaks(e.state, '@yuki: O Ren chegou atrasado.').map((l) => l.who.id)).toEqual(['ren']);
    expect(nameLeaks(e.state, 'A aula começa.\n>> Pergunto à Mei o que houve.').map((l) => l.who.id)).toEqual(['mei']);
    expect(nameLeaks(room(true).state, 'Yuki Sato levanta a mão.')).toEqual([]);
  });

  it('o sobrenome de duas pessoas só conta com o nome inteiro', () => {
    const e = room(false);
    e.createCharacter({ name: 'Aiko Ito', role: 'inspetora', appearance: 'crachá', position: { near: 'kenji' } });
    expect(nameLeaks(e.state, 'O tal Ito chegou.')).toEqual([]);
    expect(nameLeaks(e.state, 'Aiko Ito chegou.').map((l) => l.who.id)).toEqual(['aiko']);
  });

  it('a fala pronta que repete o que a pessoa disse na narração sai; a que só começa igual fica', () => {
    const said = ['Um arame em gancho. Isto não se pesca — arranca-se. Mão treinada e altura medida. Fico colado ao homem da pasta.'];
    expect(repeats('Um arame em gancho, sr. gerente. Isto não se pesca — arranca-se. Mão treinada e altura medida.', said)).toBe(true);
    expect(repeats('Fico colado ao homem da pasta. Se ele a mexer, eu vejo. Discreto, como pediu.', said)).toBe(false);
    const e = room();
    runTool(e, 'set_lines', { lines: [{ who: 'ren', turn: [{ text: 'Professor, a prova foi difícil demais.' }, { text: 'Posso sair mais cedo hoje?' }] }] });
    expect(dropRepeated(e.state.characters.ren, ['A prova foi difícil demais, professor!'])).toBe(1);
    expect(e.state.characters.ren.lines!.turn.map((l) => l.text)).toEqual(['Posso sair mais cedo hoje?']);
  });
});

describe('conferência com o Jev', () => {
  it('pergunta só de quem a narração fala, e cruza "mudou de lugar" com o que o estado mudou', async () => {
    const e = room();
    const before = snapshot(e);
    const plan = planCheck(turn(e, before, 'Ren se levanta e vai até a janela. {ren:aponta}', 'Olho a turma.'));
    const [narrationKeys, actionKeys] = plan.requests.map((r) => Object.keys(r.questions));
    expect(narrationKeys).toEqual(expect.arrayContaining(['move_ren', 'pose_ren', 'gesto_ren', 'move_kenji', 'tu']));
    expect(narrationKeys).not.toContain('move_yuki');
    // O que depende da ação do jogador vai à parte, com ela; o pedido da narração não a vê.
    expect(actionKeys).toEqual(expect.arrayContaining(['agressao', 'deve_ren', 'objeto_usado']));
    expect(plan.requests[0].state).not.toHaveProperty('acao_do_jogador');
    expect(plan.requests[1].state).toHaveProperty('acao_do_jogador', 'Olho a turma.');
    const { client } = fakeJev({ move_ren: sim() });
    const moved = await new JevChecker(client).check(turn(e, before, 'Ren se levanta e vai até a janela.'));
    expect(moved.verdict?.issues).toEqual(['Ren Ito muda de lugar na narração, mas a posição no estado não mudou (falta move_character).']);
    runTool(e, 'move_character', { character_id: 'ren', to: { near: 'kenji' } });
    expect((await new JevChecker(client).check(turn(e, before, 'Ren se levanta e vai até a janela.'))).verdict).toEqual({ consistent: true, issues: [] });
  });

  it('gesto sem marca, "tu", tempo que não passou e quem só assiste viram problemas', async () => {
    const e = room();
    e.createCharacter({ name: 'Aiko Ito', role: 'inspetora da escola', appearance: 'crachá', position: { near: 'kenji' } });
    runTool(e, 'introduce', { who: ['kenji'], knows: ['aiko'] });
    const before = snapshot(e);
    const { client } = fakeJev({ gesto_yuki: escolhe('sim'), tu: sim(), tempo: sim(), agressao: sim(), deve_aiko: sim(), age_aiko: sim(0.05) });
    const r = await new JevChecker(client).check(turn(e, before, 'Yuki assente. Voltas à tua mesa, e duas horas passam enquanto a Aiko só olha.', 'Dou um soco no Ren.'));
    expect(r.verdict?.issues).toEqual([
      'Yuki Sato faz que sim com a cabeça na narração sem a marca {yuki:sim} na mesma frase.',
      'A narração trata o jogador por "tu" (voltas, teu, estás); escreva com "você".',
      'A narração faz o tempo passar, mas o relógio não andou (falta advance_time).',
      'Aiko Ito deveria agir contra o que o jogador fez (inspetora da escola) e na narração só assiste; mostre a reação.',
    ]);
    expect(r.usages.map((u) => u.model)).toEqual(['jev-1.14.0', 'jev-1.14.0']);
  });

  it('fatos parecidos dividem a escolha, e a soma ainda acusa; quem conta o que não sabe não "descobre"', async () => {
    const e = room();
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei levou cola para a prova.', known_by: ['mei'] });
    const [a, b] = e.state.facts.slice(-2).map((f) => f.id);
    const before = snapshot(e);
    const split: JevAnswer = { type: 'choice', choice: a, confidence: 0.2, probabilities: { [a]: 0.4, [b]: 0.35, nenhum: 0.25 } };
    const { client } = fakeJev({ vaza_ren: split, descobre_ren: split });
    const r = await new JevChecker(client).check(turn(e, before, '@ren: A Mei colou na prova!'));
    expect(r.verdict?.issues).toEqual([`Ren Ito fala ou age sabendo de ${a} («Mei colou na prova.»), que não sabe; mostre como descobriu (share_knowledge) ou reescreva.`]);
  });

  it('quem fala do que não sabe, a fala pronta que usa um fato que a pessoa não sabe e o nome de um estranho', async () => {
    const e = room();
    runTool(e, 'add_fact', { subject: 'mei', text: 'Mei colou na prova.', known_by: ['mei'] });
    const fact = e.state.facts.at(-1)!.id;
    const before = snapshot(e);
    runTool(e, 'set_lines', { lines: [{ who: 'yuki', turn: [{ text: 'A Mei colou, todo mundo sabe.' }] }] });
    e.createCharacter({ name: 'Hana Mori', role: 'diretora', appearance: 'terno', position: { near: 'kenji' } });
    const { client, asked } = fakeJev({ vaza_ren: escolhe(fact), fala_yuki_0: escolhe(fact) });
    const r = await new JevChecker(client).check(turn(e, before, '@ren: Eu sei que a Mei colou. Hana Mori entra na sala.'));
    expect(asked.find((q) => q.vaza_ren)?.vaza_ren).toMatchObject({ type: 'choice', criteria: { nenhum: 'nenhum destes fatos', [fact]: 'Mei colou na prova.' } });
    expect(r.verdict?.issues[0]).toContain('A narração chama pelo nome Hana Mori quem o jogador não conhece');
    expect(r.verdict?.issues.slice(1)).toEqual([
      `Ren Ito fala ou age sabendo de ${fact} («Mei colou na prova.»), que não sabe; mostre como descobriu (share_knowledge) ou reescreva.`,
      `A fala pronta de Yuki Sato «A Mei colou, todo mundo sabe.» usa ${fact}, que Yuki Sato não sabe; troque a fala.`,
    ]);
  });

  it('sem chave, ou com o Jev fora do ar, quem confere é o modelo, e o nome indevido continua valendo', async () => {
    const e = room(false);
    const before = snapshot(e);
    const llm = new FixedChecker({ consistent: false, issues: ['Ren some sem motivo.'] });
    const noKey = await new JevChecker(new JevClient({ apiKey: () => undefined }), llm).check(turn(e, before, 'Ren Ito acena.'));
    expect(noKey.verdict?.issues).toEqual([expect.stringContaining('chama pelo nome Ren Ito'), 'Ren some sem motivo.']);
    const down = new JevClient({ apiKey: () => 'k', fetch: (async () => new Response('fora', { status: 500 })) as unknown as typeof fetch });
    const r = await new JevChecker(down, llm).check(turn(e, before, 'Ren Ito acena.'));
    expect(r.verdict?.issues).toEqual([expect.stringContaining('chama pelo nome Ren Ito'), 'Ren some sem motivo.']);
    expect(r.note).toContain('Jev indisponível (Jev respondeu 500');
  });

  it('em "ambos" o jogo segue o modelo, e os dois vereditos vão para o registro', async () => {
    const e = room();
    const before = snapshot(e);
    const entries: ShadowEntry[] = [];
    const { client } = fakeJev({ tu: sim() });
    const r = await new ShadowChecker(new FixedChecker({ consistent: true, issues: [] }), new JevChecker(client), (entry) => entries.push(entry)).check(turn(e, before, 'Voltas à tua mesa.'));
    expect(r.verdict).toEqual({ consistent: true, issues: [] });
    expect(r.usages.map((u) => u.model)).toEqual(['claude-haiku-5-5', 'jev-1.14.0', 'jev-1.14.0']);
    expect(entries[0].shadow.verdict?.issues).toEqual(['A narração trata o jogador por "tu" (voltas, teu, estás); escreva com "você".']);
    expect(entries[0].primary.usd).toBeGreaterThan(0);
  });

  it('CRPS_VERIFY escolhe quem confere: o Jev com o modelo de reserva, só o modelo, ou os dois', () => {
    const provider: ModelProvider = {
      label: 'falso',
      startSession: () => {
        throw new Error('sem sessão');
      },
      verify: async () => ({ verdict: { consistent: true, issues: [] } }),
    };
    expect(checkerFor(provider, 'llm')).toBeInstanceOf(LlmChecker);
    expect(checkerFor(provider, undefined)).toBeInstanceOf(JevChecker);
    expect(checkerFor(provider, 'jev')).toBeInstanceOf(JevChecker);
    expect(checkerFor(provider, 'ambos', 'saves/nao-usado')).toBeInstanceOf(ShadowChecker);
  });
});
