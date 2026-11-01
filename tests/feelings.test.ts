import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { feelingsHere } from '../src/engine/perception';
import { runTool } from '../src/engine/tools';
import { SYSTEM_PROMPT, setupMessage, turnMessage, verifierFeedback, verifierPrompt } from '../src/gm/prompts';

/** Enfermaria com Henrique (jogador), Lúcia ao lado dele e o enfermeiro Abelardo; Dora está no pátio. */
function ward(seed = 5): GameEngine {
  const e = GameEngine.create('teste', seed);
  e.createLocation({ id: 'enfermaria', name: 'Enfermaria', description: '', layout: ['#######', '#.....#', '#.....D', '#######'] });
  e.createLocation({ id: 'patio', name: 'Pátio', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
  e.createCharacter({ name: 'Henrique Lobo', role: 'paciente', appearance: '', is_player: true, location_id: 'enfermaria', position: { x: 1, y: 1 } });
  e.createCharacter({ name: 'Lúcia Prado', role: 'paciente', appearance: '', location_id: 'enfermaria', position: { x: 2, y: 1 } });
  e.createCharacter({ name: 'Abelardo Cruz', role: 'enfermeiro', appearance: '', location_id: 'enfermaria', position: { x: 5, y: 2 } });
  e.createCharacter({ name: 'Dora Lima', role: 'cozinheira', appearance: '', location_id: 'patio', position: { x: 1, y: 1 } });
  e.introduce({ group: ['henrique', 'lucia', 'abelardo', 'dora'] });
  return e;
}

function telepathy(e: GameEngine): void {
  e.extendRuleset({ reason: 'poder', perks: [{ name: 'Telepatia', description: '', grants: [{ kind: 'sense', channel: 'mente', bonus: 5 }] }] });
  e.updateCharacter({ character_id: 'henrique', perks_add: ['telepatia'] });
}

describe('sentimentos', () => {
  it('registra, muda e apaga o que um NPC sente; o do personagem do jogador fica com o jogador', () => {
    const e = ward();
    const r = runTool(e, 'set_feelings', {
      feelings: [
        { who: 'lucia', toward: 'henrique', degree: 1, text: 'às vezes o confunde com o filho' },
        { who: 'Abelardo', toward: 'Henrique', degree: -1, text: 'acha que ele finge a crise' },
      ],
    });
    expect(r.summary).toBe('🤫 Sentimentos: Lúcia → Henrique +1, Abelardo → Henrique -1');
    expect(e.state.characters.lucia.feelings.henrique).toEqual({ degree: 1, text: 'às vezes o confunde com o filho' });

    // Um tapa numa paciente muda o que o enfermeiro sente, aos poucos.
    const slap = runTool(e, 'set_feelings', { feelings: [{ who: 'abelardo', toward: 'henrique', degree: -2, text: 'bateu numa paciente' }] });
    expect(slap.summary).toBe('🤫 Sentimentos: Abelardo → Henrique -2 (era -1)');
    // Grau 0 sem texto apaga.
    runTool(e, 'set_feelings', { feelings: [{ who: 'abelardo', toward: 'henrique', degree: 0, text: '' }] });
    expect(e.state.characters.abelardo.feelings).toEqual({});

    // O que o personagem do jogador sente, quem diz é o jogador; e a chamada é atômica.
    const player = runTool(e, 'set_feelings', {
      feelings: [
        { who: 'lucia', toward: 'abelardo', degree: 2, text: 'ele traz o chá' },
        { who: 'henrique', toward: 'lucia', degree: 3, text: 'quer protegê-la' },
      ],
    });
    expect(player.ok).toBe(false);
    expect(player.content).toContain('quem diz é o jogador');
    expect(e.state.characters.lucia.feelings.abelardo).toBeUndefined();
    expect(runTool(e, 'set_feelings', { feelings: [{ who: 'lucia', toward: 'henrique', degree: 4, text: '' }] }).ok).toBe(false);
    expect(runTool(e, 'set_feelings', { feelings: [{ who: 'lucia', toward: 'lucia', degree: 1, text: '' }] }).ok).toBe(false);
  });

  it('o resumo mostra o que cada NPC sente por quem está ali, e marca quando o jogador lê a mente dele', () => {
    const e = ward();
    e.setFeelings([
      { who: 'lucia', toward: 'henrique', degree: 1, text: 'às vezes o confunde com o filho' },
      { who: 'lucia', toward: 'dora', degree: 2, text: 'a sopa dela lembra a de casa' },
    ]);
    const brief = compileBrief(e, { recentTurns: 0 });
    expect(brief).toContain('; sente: por Henrique +1 (simpatia: "às vezes o confunde com o filho")');
    // Quem não está ali fica na ficha (inspect), não no resumo.
    expect(brief).not.toContain('a sopa dela');
    expect(e.sheet(e.state.characters.lucia).feelings).toEqual([
      { toward: 'henrique', name: 'Henrique Lobo', degree: 1, text: 'às vezes o confunde com o filho' },
      { toward: 'dora', name: 'Dora Lima', degree: 2, text: 'a sopa dela lembra a de casa' },
    ]);
    expect(feelingsHere(e.state, e.state.characters.lucia).map((f) => f.target.id)).toEqual(['henrique']);

    telepathy(e);
    expect(compileBrief(e, { recentTurns: 0 })).toContain('; sente (o jogador percebe): por Henrique +1');
  });

  it('o resumo aponta por quem cada NPC ainda não tem sentimento, e indiferença registrada conta', () => {
    const e = ward();
    e.setFeelings([{ who: 'lucia', toward: 'henrique', degree: 1, text: 'às vezes o confunde com o filho' }]);
    const line = (id: string) => compileBrief(e, { recentTurns: 0 }).split('\n').find((l) => l.includes(`[${id}]`))!;
    expect(line('lucia')).toContain('"às vezes o confunde com o filho"); falta sentimento por: Abelardo');
    expect(line('abelardo')).toContain('; falta sentimento por todos aqui');
    expect(line('henrique')).not.toContain('falta sentimento');

    e.setFeelings([
      { who: 'abelardo', toward: 'lucia', degree: 0, text: 'mal fala com ela' },
      { who: 'abelardo', toward: 'henrique', degree: -1, text: 'acha que ele finge a crise' },
    ]);
    expect(line('abelardo')).not.toContain('falta sentimento');
    expect(line('abelardo')).toContain('por Lúcia 0 (indiferença: "mal fala com ela")');

    // Numa cena cheia, os quatro primeiros e a conta do resto.
    for (const name of ['Ana Reis', 'Bia Lopes', 'Davi Melo', 'Eva Dias', 'Fábio Leal', 'Gil Rocha']) {
      e.createCharacter({ name, role: 'paciente', appearance: '', location_id: 'enfermaria' });
    }
    expect(line('abelardo')).toContain('; falta sentimento por: Ana, Bia, Davi, Eva e mais 2');
  });

  it('pedir algo a quem gosta de você soma o grau, e o chip só mostra o porquê a quem lê a mente do alvo', () => {
    const ask = { character_id: 'henrique', attribute: 'presenca', difficulty: 'normal', reason: 'pedir o remédio', target_id: 'lucia' };
    const plain = ward(9);
    const fond = ward(9);
    fond.setFeelings([{ who: 'lucia', toward: 'henrique', degree: 2, text: 'ele a escuta' }]);
    const a = runTool(plain, 'skill_check', ask).data as { total: number; feeling_bonus: number };
    const b = runTool(fond, 'skill_check', { ...ask, goodwill: true });
    const rb = b.data as { total: number; feeling_bonus: number };
    expect(rb.feeling_bonus).toBe(2);
    expect(rb.total).toBe(a.total + 2);
    // Sem ler a mente de Lúcia, o jogador vê os dados e o resultado, não a conta.
    expect(b.summary).toMatch(/: \d\+\d → /);
    expect(b.summary).not.toContain('afeição');

    const reader = ward(9);
    reader.setFeelings([{ who: 'lucia', toward: 'henrique', degree: 2, text: 'ele a escuta' }]);
    telepathy(reader);
    expect(runTool(reader, 'skill_check', { ...ask, goodwill: true }).summary).toContain('+2 (afeição de Lúcia)');
    // Intimidar não depende de boa vontade: sem goodwill, o grau não conta.
    const scare = ward(9);
    scare.setFeelings([{ who: 'lucia', toward: 'henrique', degree: 2, text: 'ele a escuta' }]);
    expect((runTool(scare, 'skill_check', { ...ask, reason: 'intimidar' }).data as { feeling_bonus: number }).feeling_bonus).toBe(0);
    const { target_id: _target, ...alone } = ask;
    expect(runTool(plain, 'skill_check', { ...alone, goodwill: true }).content).toContain('goodwill precisa de target_id');
  });

  it('save antigo carrega sem sentimentos', () => {
    const raw = JSON.parse(ward().toJSON());
    for (const c of Object.values(raw.characters) as Record<string, unknown>[]) delete c.feelings;
    const loaded = GameEngine.fromJSON(JSON.stringify(raw));
    expect(loaded.state.characters.lucia.feelings).toEqual({});
    expect(compileBrief(loaded)).not.toContain('; sente');
  });

  it('o mestre baseia a reação no sentimento pelos envolvidos, em qualquer cenário, e o verificador cobra o que mudou', () => {
    expect(SYSTEM_PROMPT).toContain('pelo que sentem por quem está ali (o resumo mostra os cinco)');
    expect(SYSTEM_PROMPT).toContain('A base, em qualquer cenário, é o que ele sente pelos envolvidos, por quem agiu e por quem sofreu');
    expect(SYSTEM_PROMPT).toContain('Todo NPC que reage precisa de sentimento registrado por quem agiu e por quem sofreu (o resumo aponta o que falta em "falta sentimento por")');
    expect(SYSTEM_PROMPT).toContain('inclusive em quem sofreu: quem vive no próprio mundo pode nem registrar');
    expect(SYSTEM_PROMPT).toContain('o skill_check vai com target_id e goodwill');
    expect(setupMessage('Uma escola.')).toContain('Com set_feelings, registre o que cada NPC sente por quem conhece de perto');
    expect(turnMessage('', 'Dou um tapa nela.')).toContain('inclusive quem sofreu a ação, reage do jeito dele');
    expect(turnMessage('', 'Dou um tapa nela.')).toContain('set_feelings registra o sentimento que faltava e o que o turno mudou');
    expect(verifierPrompt({ state: '', changes: [], input: '', narration: '' })).toContain('- sentimento: a narração mostra que o que um NPC sente');
    expect(verifierPrompt({ state: '', changes: [], input: '', narration: '' })).toContain('- sentimento que falta: um NPC reage na narração a quem agiu ou a quem sofreu');
    expect(verifierFeedback(['Otávio defende Lúcia sem sentimento por ela.'])).toContain('Num sentimento que falta, registre com set_feelings o que a cena mostrou');
    // Nada preso a um cenário: estados como sanidade são regras da campanha, não do prompt.
    expect(`${SYSTEM_PROMPT}\n${setupMessage('x')}\n${turnMessage('', 'x')}`).not.toMatch(/\b(asilo|sanidade|lucidez|delír|paciente)/i);
  });
});
