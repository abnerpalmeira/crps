import { describe, expect, it } from 'vitest';
import { actionsFor } from '../src/engine/actions';
import { compileBrief } from '../src/engine/brief';
import { stepsFor } from '../src/engine/effects';
import { GameEngine } from '../src/engine/engine';
import { freeAct } from '../src/engine/free';
import { hasNews, nextLine } from '../src/engine/lines';
import { distanceBetween } from '../src/engine/perception';
import { EXAMPLE_CLASSROOM, runTool } from '../src/engine/tools';

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

/**
 * Sala com o professor perto do quadro e três alunos sentados; por padrão ele conhece a turma. Os
 * passos por turno dão para cruzar a sala (`steps`), salvo nos testes dos próprios passos.
 */
function room(knowsClass = true, steps = 40): GameEngine {
  const e = GameEngine.create('Sou professor numa escola japonesa.', 42);
  e.defineRuleset({ name: 'Escola', attributes: [{ name: 'Carisma', description: '' }], resources: [{ name: 'Energia', max: 10, description: '' }], movement: { steps } });
  e.createLocation({ id: 'sala', name: 'Sala 1-A', description: 'Sala de aula.', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: 'gravata torta', is_player: true, position: { near: 'sala/quadro-1' } });
  for (const name of ['Yuki Sato', 'Ren Ito', 'Mei Kato']) e.createCharacter({ name, role: 'aluno(a)', appearance: 'uniforme', position: { seat: 'random' } });
  if (knowsClass) runTool(e, 'introduce', { group: ['kenji', 'yuki', 'ren', 'mei'] });
  return e;
}

/** O aluno mais longe do professor. */
function farthest(e: GameEngine): string {
  return ['yuki', 'ren', 'mei'].sort((a, b) => distanceBetween(e.state, 'kenji', b)! - distanceBetween(e.state, 'kenji', a)!)[0];
}

describe('falas prontas', () => {
  it('set_lines guarda as do turno, as gerais e a iniciativa; o jogador não tem, e a fala não leva marca', async () => {
    const e = room();
    const r = runTool(e, 'set_lines', { lines: [{ who: 'yuki', initiative: 'vem', turn: lines('Professor, a prova é hoje?'), general: lines('Gosto de desenhar.', 'Bom dia!') }] });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('🤫 Falas prontas: Yuki (1 do turno, 2 gerais, vem)');
    expect(e.state.characters.yuki.lines).toEqual({ turn: lines('Professor, a prova é hoje?'), general: lines('Gosto de desenhar.', 'Bom dia!'), heard: 0, initiative: 'vem' });
    expect(runTool(e, 'set_lines', { lines: [{ who: 'kenji', general: lines('Oi.') }] }).content).toContain('quem decide é o jogador');
    expect(runTool(e, 'set_lines', { lines: [{ who: 'ren', general: lines('@ren: Oi.') }] }).content).toContain('sem @id nem {gesto}');
    // Só a lista que vem muda; "nenhuma" tira a iniciativa.
    runTool(e, 'set_lines', { lines: [{ who: 'yuki', turn: lines('E o trabalho?'), initiative: 'nenhuma' }] });
    expect(e.state.characters.yuki.lines).toMatchObject({ general: lines('Gosto de desenhar.', 'Bom dia!') });
    expect(e.state.characters.yuki.lines!.initiative).toBeUndefined();
  });

  it('as do turno saem na ordem, depois as gerais em rodízio; o próximo turno do mestre limpa as do turno e a iniciativa', async () => {
    const e = room();
    e.setLines([
      { who: 'yuki', turn: lines('A', 'B'), general: lines('G1', 'G2'), initiative: 'chama' },
      { who: 'ren', turn: lines('Só essa.') },
    ]);
    const yuki = e.state.characters.yuki;
    const heard: string[] = [];
    for (let i = 0; i < 5; i++) {
      heard.push(nextLine(yuki)!.text);
      yuki.lines!.heard++;
    }
    expect(heard).toEqual(['A', 'B', 'G1', 'G2', 'G1']);
    expect(hasNews(yuki)).toBe(false);
    // Sem gerais, repete a última.
    const ren = e.state.characters.ren;
    ren.lines!.heard = 3;
    expect(nextLine(ren)!.text).toBe('Só essa.');
    e.beginTurn();
    expect(yuki.lines).toEqual({ turn: [], general: lines('G1', 'G2'), heard: 0 });
    expect(nextLine(ren)).toBeNull();
  });

  it('saves com as falas de antes (só texto) continuam valendo', async () => {
    const e = room();
    (e.state.characters.yuki as unknown as { lines: unknown }).lines = { turn: ['Oi!'], general: ['Tchau.'], heard: 0 };
    const loaded = GameEngine.fromJSON(e.toJSON());
    expect(loaded.state.characters.yuki.lines).toEqual({ turn: lines('Oi!'), general: lines('Tchau.'), heard: 0 });
  });

  it('conversar: o jogador vai até a pessoa, ouve a próxima fala, e o próximo turno do mestre fica sabendo', async () => {
    const e = room();
    const far = farthest(e);
    expect(distanceBetween(e.state, 'kenji', far)!).toBeGreaterThan(2);
    e.setLines([{ who: far, turn: lines('Professor, eu não fiz o trabalho.'), general: lines('Hoje tem educação física?') }]);
    expect(hasNews(e.state.characters[far])).toBe(true);

    const first = await freeAct(e, { kind: 'talk', with: far });
    expect(first.ok).toBe(true);
    expect(first.entries).toHaveLength(2);
    expect(first.entries[1]).toBe(`@${far}[>kenji]: Professor, eu não fiz o trabalho.`);
    expect(distanceBetween(e.state, 'kenji', far)!).toBeLessThanOrEqual(2);
    expect(hasNews(e.state.characters[far])).toBe(false);

    const second = await freeAct(e, { kind: 'talk', with: far });
    expect(second.entries).toEqual([`@${far}[>kenji]: Hoje tem educação física?`]);
    expect(e.state.log.at(-1)).toMatchObject({ kind: 'free', text: second.entries[0] });
    expect(compileBrief(e)).toContain(`T0 Livre: @${far}[>kenji]: Hoje tem educação física?`);
  });

  it('a fala que conta um fato ensina a quem ouve; só quem sabe pode contar', async () => {
    const e = room();
    const far = farthest(e);
    const fact = e.addFact({ subject: far, text: 'Ainda não entregou o trabalho de história', known_by: [far] });
    const knows = (id: string) => e.knows(id, e.state.facts.find((f) => f.id === fact.id)!);
    expect(knows('kenji')).toBe(false);
    const other = ['yuki', 'ren', 'mei'].find((id) => id !== far)!;
    expect(runTool(e, 'set_lines', { lines: [{ who: other, turn: [{ text: 'Ele não fez o trabalho.', fact_id: fact.id }] }] }).content).toContain('não sabe');
    e.setLines([{ who: far, turn: [{ text: 'Professor… eu não entreguei o trabalho.', fact_id: fact.id }] }]);
    expect(compileBrief(e)).toContain(`«Professor… eu não entreguei o trabalho.» (conta ${fact.id})`);
    await freeAct(e, { kind: 'talk', with: far });
    // Falou em voz normal numa sala: o professor e quem estava perto ouviram.
    expect(knows('kenji')).toBe(true);
  });

  it('a fala cochichada conta o segredo só ao jogador', async () => {
    const e = room();
    const far = farthest(e);
    const fact = e.addFact({ subject: far, text: 'Colou na prova de ontem', known_by: [far] });
    e.setLines([{ who: far, turn: [{ text: 'Professor, preciso confessar uma coisa…', fact_id: fact.id, whisper: true }] }]);
    expect(compileBrief(e)).toContain(`«Professor, preciso confessar uma coisa…» (conta ${fact.id}) (cochicho)`);
    const r = await freeAct(e, { kind: 'talk', with: far });
    expect(r.entries[1]).toBe(`@${far}[cochicho>kenji]: Professor, preciso confessar uma coisa…`);
    expect(e.state.facts.find((f) => f.id === fact.id)!.knownBy).toEqual([far, 'kenji']);
  });

  it('a fala em que a pessoa diz o nome apresenta quem fala a quem ouve', async () => {
    const e = room(false);
    const far = farthest(e);
    e.setLines([{ who: far, turn: [{ text: 'Prazer, professor. Sou nova na turma.', introduces: true }] }]);
    expect(e.state.characters.kenji.knows).not.toContain(far);
    const r = await freeAct(e, { kind: 'talk', with: far });
    // A própria fala apresenta: no registro ela já sai com o nome, e daqui em diante ele sabe quem é.
    expect(r.entries[1]).toBe(`@${far}[>kenji]: Prazer, professor. Sou nova na turma.`);
    expect(e.state.characters.kenji.knows).toContain(far);
  });

  it('andar até um tile é livre; num tile em que não dá para ficar, vai para o livre mais perto', async () => {
    const e = room();
    const walk = await freeAct(e, { kind: 'walk', x: 12, y: 9 });
    expect(walk.ok).toBe(true);
    expect(e.state.characters.kenji.pos).toEqual({ x: 12, y: 9 });
    expect(e.state.log.at(-1)).toMatchObject({ kind: 'free', text: walk.entries[0] });
    // A parede do canto: o clique leva ao tile livre mais perto dela.
    expect((await freeAct(e, { kind: 'walk', x: 0, y: 0 })).ok).toBe(true);
    expect(e.state.characters.kenji.pos).toEqual({ x: 1, y: 1 });
    // Clicar onde já está não faz nada.
    expect(await freeAct(e, { kind: 'walk', x: 1, y: 1 })).toEqual({ ok: true, entries: [] });
  });

  it('sentar e pegar pelo menu acontecem na hora; sacar arma e mirar ficam com o mestre', async () => {
    const e = room();
    const loc = e.state.locations.sala;
    const seat = loc.fixtures.find((f) => f.seat && !Object.values(e.state.characters).some((c) => c.seatId === f.id))!;
    const sit = await freeAct(e, { kind: 'act', verb: 'sentar', target: seat.id, other: null });
    expect(sit.ok).toBe(true);
    expect(e.state.characters.kenji.seatId).toBe(seat.id);
    expect(e.state.log.at(-1)).toMatchObject({ kind: 'free' });

    e.createItem({ name: 'Pedra', description: 'uma pedrinha lisa', holder: { x: 12, y: 9, location_id: 'sala' } });
    const take = await freeAct(e, { kind: 'act', verb: 'pegar', target: 'pedra', other: null });
    expect(take.ok).toBe(true);
    expect(e.state.items.pedra.holder).toMatchObject({ kind: 'character', id: 'kenji' });

    e.createItem({ name: 'Bastão', description: '', holder: { character_id: 'kenji' }, grip: 'uma_mao' });
    expect(await freeAct(e, { kind: 'act', verb: 'empunhar', target: 'bastao', other: null })).toMatchObject({ ok: false, error: expect.stringContaining('mestre') });
    expect(await freeAct(e, { kind: 'act', verb: 'mirar', target: 'ren', other: null })).toMatchObject({ ok: false, error: expect.stringContaining('mestre') });
  });

  it('o motor recusa sem mexer em nada: alvo que não existe, conversa sem fala pronta', async () => {
    const e = room();
    const before = { ...e.state.characters.kenji.pos! };
    expect((await freeAct(e, { kind: 'walk', near: 'piano' })).ok).toBe(false);
    expect(await freeAct(e, { kind: 'talk', with: 'ren' })).toMatchObject({ ok: false, entries: [] });
    expect(e.state.characters.kenji.pos).toEqual(before);
    expect(e.state.log.some((l) => l.kind === 'free')).toBe(false);
  });
});

/** Uma ação livre que não é andar: mudar a postura ali mesmo. */
const pose = (target: string) => ({ kind: 'act' as const, verb: 'pose', target, other: null });

describe('passos por turno', () => {
  it('o ruleset dá a base, o atributo soma, e perks e condições com move somam ou multiplicam', () => {
    const e = room(true, 6);
    expect(stepsFor(e.state, 'kenji')).toBe(6);
    e.extendRuleset({ attributes: [{ name: 'Agilidade', description: '' }], movement: { attribute: 'agilidade', per_point: 2 }, reason: 'corrida' });
    runTool(e, 'update_character', { character_id: 'kenji', attributes: { agilidade: 1 } });
    expect(stepsFor(e.state, 'kenji')).toBe(8);
    e.extendRuleset({
      perks: [{ name: 'Ágil', description: 'rápido', grants: [{ kind: 'move', bonus: 2 }] }],
      conditions: [{ name: 'Perna ferida', description: 'manca', grants: [{ kind: 'move', factor: 0.5 }] }],
      reason: 'tombo',
    });
    runTool(e, 'update_character', { character_id: 'kenji', perks_add: ['agil'], conditions_add: ['perna_ferida'] });
    expect(stepsFor(e.state, 'kenji')).toBe(5);
    expect(compileBrief(e)).toContain('Passos por turno: 6 (+2 por ponto de agilidade)');
  });

  it('andar no grid gasta os passos do turno, sem chamar quem decide: até o fim, se dão; até onde dão, se não', async () => {
    const e = room(true, 4);
    let asked = false;
    const hooks = { initiative: async () => ((asked = true), null) };
    // Do (6,1), pela fileira da frente: 4 passos até (10,1).
    expect(await freeAct(e, { kind: 'walk', x: 10, y: 1 }, hooks)).toMatchObject({ ok: true });
    expect(e.state.characters.kenji).toMatchObject({ pos: { x: 10, y: 1 }, steps: { max: 4, used: 4 } });
    expect(asked).toBe(false);
    expect(await freeAct(e, { kind: 'walk', x: 12, y: 1 })).toMatchObject({ ok: false, error: expect.stringContaining('acabaram') });
    expect(e.state.characters.kenji.pos).toEqual({ x: 10, y: 1 });
    // Turno novo: os passos voltam, e o caminho maior que eles para no último passo possível.
    e.startTurnSteps();
    const far = await freeAct(e, { kind: 'walk', x: 1, y: 1 });
    expect(far).toMatchObject({ ok: true, note: expect.stringContaining('acabaram') });
    expect(e.state.characters.kenji).toMatchObject({ pos: { x: 6, y: 1 }, steps: { used: 4 } });
    // Quem não chega até a pessoa não conversa; o mestre move sem gastar passos.
    e.setLines([{ who: 'mei', turn: lines('Professor?') }]);
    expect(await freeAct(e, { kind: 'talk', with: 'mei' })).toMatchObject({ ok: false, error: expect.stringContaining('Longe demais') });
    runTool(e, 'move_character', { character_id: 'kenji', to: { x: 12, y: 1 } });
    expect(e.state.characters.kenji).toMatchObject({ pos: { x: 12, y: 1 }, steps: { used: 4 } });
  });
});

describe('iniciativa', () => {
  it('quem "vem" vai até o jogador depois de uma ação livre e diz a fala do turno, uma vez só; andar não chama ninguém', async () => {
    const e = room();
    await freeAct(e, { kind: 'walk', x: 12, y: 9 });
    const far = farthest(e);
    e.setLines([{ who: far, initiative: 'vem', turn: lines('Professor! Espera, preciso falar com o senhor.') }]);
    // Andar nos passos do turno é só do motor: ninguém vem.
    expect((await freeAct(e, { kind: 'walk', x: 11, y: 9 })).entries).toHaveLength(1);
    const r = await freeAct(e, pose('bracos_cruzados'));
    expect(r.entries).toHaveLength(3);
    expect(r.entries[2]).toBe(`@${far}[>kenji]: Professor! Espera, preciso falar com o senhor.`);
    expect(distanceBetween(e.state, 'kenji', far)!).toBeLessThanOrEqual(2);
    expect(hasNews(e.state.characters[far])).toBe(false);
    // Já disse o que tinha: na próxima ação, ninguém vem.
    expect((await freeAct(e, pose('pensativo'))).entries).toHaveLength(1);
  });

  it('quem "chama" fala de onde está; quem não tem iniciativa espera o jogador', async () => {
    const e = room();
    await freeAct(e, { kind: 'walk', x: 12, y: 9 });
    const far = farthest(e);
    const quiet = ['yuki', 'ren', 'mei'].find((id) => id !== far)!;
    const before = { ...e.state.characters[far].pos! };
    e.setLines([
      { who: far, initiative: 'chama', turn: lines('Professor, aqui!') },
      { who: quiet, turn: lines('Eu só falo se o senhor vier.') },
    ]);
    const r = await freeAct(e, pose('bracos_cruzados'));
    expect(r.entries).toHaveLength(2);
    expect(r.entries[1]).toMatch(new RegExp(`^@${far}\\[(grito)?>kenji\\]: Professor, aqui!$`));
    expect(e.state.characters[far].pos).toEqual(before);
    expect(hasNews(e.state.characters[quiet])).toBe(true);
  });
});

describe('menu e resumo', () => {
  it('o menu oferece conversar com quem tem fala pronta; ir até alguém e sentar são livres', async () => {
    const e = room();
    e.setLines([{ who: 'yuki', turn: lines('Oi!') }]);
    const world = e.snapshot();
    const yuki = actionsFor(world, { kind: 'character', id: 'yuki' });
    expect(yuki[0]).toMatchObject({ label: '💬 Conversar', free: { kind: 'talk', with: 'yuki' }, note: 'tem algo a dizer' });
    expect(yuki.find((a) => a.label === 'Ir até')).toMatchObject({ free: { kind: 'walk', near: 'yuki' } });
    expect(actionsFor(world, { kind: 'character', id: 'ren' }).some((a) => a.free?.kind === 'talk')).toBe(false);
    // A porta da sala ainda não leva a lugar nenhum: passar por ela é com o mestre.
    const door = e.state.locations.sala.fixtures.find((f) => f.exit)!;
    expect(actionsFor(world, { kind: 'fixture', id: door.id }).find((a) => a.label.startsWith('Passar'))).toMatchObject({ token: `{passar>${door.id}}`, free: undefined });
  });

  it('o resumo do mestre mostra as falas de cada NPC, o que revelam e quem ainda não tem as gerais', async () => {
    const e = room();
    e.setLines([{ who: 'yuki', initiative: 'vem', turn: [{ text: 'A prova é hoje?' }, { text: 'Sou a Yuki, lembra?', introduces: true }], general: lines('Bom dia!') }]);
    const brief = compileBrief(e);
    expect(brief).toContain('falas do turno: «A prova é hoje?» «Sou a Yuki, lembra?» (diz o nome); iniciativa: vem; falas gerais: «Bom dia!»');
    expect(brief).toMatch(/Ren Ito \[ren\].*; sem falas gerais/);
  });
});
