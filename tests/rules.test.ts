import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { lifeStatId, perceptionOf } from '../src/engine/perception';
import { EXAMPLE_CLASSROOM, runTool, toolSpecs } from '../src/engine/tools';
import type { WorldState } from '../src/engine/types';
import { verifierPrompt } from '../src/gm/prompts';

/** Sala com professor (jogador) e três alunos, numa campanha de slice of life. */
function school(): GameEngine {
  const e = GameEngine.create('Slice of life escolar', 11);
  e.defineRuleset({
    name: 'Vida Escolar',
    attributes: [
      { name: 'Paciência', description: '' },
      { name: 'Carisma', description: '' },
    ],
    resources: [{ name: 'Energia', max: 10, description: '' }],
  });
  e.createLocation({ id: 'sala', name: 'Sala 2-B', description: '', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { near: 'sala/quadro-1' } });
  for (const name of ['Yuki Sato', 'Haruto Mori', 'Ren Ito']) {
    e.createCharacter({ name, role: 'aluno', appearance: '', position: { seat: 'random' } });
  }
  e.introduce({ group: Object.keys(e.state.characters) });
  return e;
}

describe('vida universal', () => {
  it('existe em toda campanha, oculta, mesmo se o mestre não definir', () => {
    const e = school();
    const vida = e.state.ruleset.resources.find((r) => r.core)!;
    expect(vida).toMatchObject({ id: 'vida', visibility: 'hidden', max: 10 });
    expect(Object.values(e.state.characters).every((c) => c.resources.vida === 10)).toBe(true);
  });

  it('reconhece um recurso "HP" do mestre como a vida universal', () => {
    const e = GameEngine.create('ação', 1);
    e.defineRuleset({
      name: 'Ação',
      attributes: [
        { name: 'Força', description: '' },
        { name: 'Mira', description: '' },
      ],
      resources: [{ name: 'HP', max: 30, description: '', visibility: 'public' }],
    });
    expect(e.state.ruleset.resources).toEqual([expect.objectContaining({ id: 'hp', max: 30, visibility: 'public', core: true })]);
    expect(lifeStatId(e.state)).toBe('hp');
  });

  it('é acrescentada a saves antigos, com o máximo para todos', () => {
    const old = JSON.parse(school().toJSON()) as WorldState;
    const legacy = old as unknown as Record<string, any>;
    legacy.ruleset.resources = legacy.ruleset.resources.filter((r: { core?: boolean }) => !r.core);
    delete legacy.ruleset.perks;
    for (const a of legacy.ruleset.attributes) {
      delete a.visibility;
      delete a.default;
    }
    for (const c of Object.values(legacy.characters) as Record<string, any>[]) {
      delete c.perks;
      delete c.thoughts;
      delete c.resources.vida;
    }
    const e = GameEngine.fromJSON(JSON.stringify(old));
    expect(e.state.ruleset.resources[0]).toMatchObject({ id: 'vida', core: true });
    expect(e.state.ruleset.attributes[0]).toMatchObject({ visibility: 'self', default: 1 });
    expect(e.findCharacter('ren')).toMatchObject({ perks: [], thoughts: null, resources: { vida: 10 } });
  });
});

describe('regras que evoluem', () => {
  it('a aula vira epidemia: pontaria, infecção e perk entram no meio da campanha', () => {
    const e = school();
    e.beginTurn();
    const r = runTool(e, 'extend_ruleset', {
      reason: 'vírus liberado no laboratório',
      attributes: [{ name: 'Pontaria', description: 'acertar o que mira' }],
      resources: [{ name: 'Infecção', max: 100, description: '', visibility: 'hidden', start: 0 }],
      perks: [{ name: 'Mira firme', description: 'treinou arco no clube', grants: [{ kind: 'check_bonus', bonus: 2, attribute: 'pontaria' }] }],
      visibility: { vida: 'public' },
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('📜 Regras ampliadas: atributo Pontaria, Vida agora público');
    expect(Object.values(e.state.characters).every((c) => c.attributes.pontaria === 0 && c.resources.infeccao === 0)).toBe(true);

    e.updateCharacter({ character_id: 'kenji', attributes: { pontaria: 2 }, perks_add: ['mira_firme'] });
    const check = e.skillCheck({ character_id: 'kenji', attribute: 'pontaria', difficulty: 'normal', reason: 'acertar o apagador' });
    expect(check.perk_bonus).toBe(2);
    expect(check.total).toBe(check.rolls[0] + check.rolls[1] + 2 + 2);
    expect(e.skillCheck({ character_id: 'kenji', attribute: 'carisma', difficulty: 'normal', reason: 'acalmar' }).perk_bonus).toBe(0);
  });

  it('recusa perk que aponta para regra inexistente e atributo repetido', () => {
    const e = school();
    expect(runTool(e, 'extend_ruleset', { reason: 'x', perks: [{ name: 'Raio-X', description: '', grants: [{ kind: 'see_stat', stat: 'mana' }] }] }).content).toMatch(
      /"mana" não é atributo nem recurso/,
    );
    expect(runTool(e, 'extend_ruleset', { reason: 'x', attributes: [{ name: 'Carisma', description: '' }] }).content).toMatch(/Já existe/);
    expect(toolSpecs()).toHaveLength(20);
  });
});

describe('percepção do jogador', () => {
  it('perks liberam ver vida e ler pensamento; sem eles, nada aparece', () => {
    const e = school();
    e.updateCharacter({ character_id: 'ren', thoughts: 'quer voltar a dormir', resource_deltas: { vida: -4 } });
    let view = perceptionOf(e.state, 'kenji');
    expect(view.canSeeStat('vida', 'ren')).toBe(false);
    expect(view.canSeeStat('energia', 'kenji')).toBe(true);
    expect(view.canSeeStat('energia', 'ren')).toBe(false);
    expect(view.canSeeThoughts('ren')).toBe(false);

    e.extendRuleset({
      reason: 'traços do professor',
      perks: [
        { name: 'Olho clínico', description: '', grants: [{ kind: 'see_stat', stat: 'vida' }] },
        { name: 'Telepata', description: '', grants: [{ kind: 'see_thoughts' }] },
      ],
    });
    e.updateCharacter({ character_id: 'kenji', perks_add: ['olho_clinico', 'telepata'] });
    view = perceptionOf(e.state, 'kenji');
    expect(view.canSeeStat('vida', 'ren')).toBe(true);
    expect(view.canSeeThoughts('ren')).toBe(true);
  });

  it('os chips não vazam vida oculta nem os números de um NPC', () => {
    const e = school();
    expect(runTool(e, 'update_character', { character_id: 'ren', resource_deltas: { vida: -3 } }).summary).toBe('🤫 Ren Ito: vida 10→7/10');
    expect(runTool(e, 'update_character', { character_id: 'kenji', resource_deltas: { energia: -1 } }).summary).toBe('✏️ Kenji Tanaka: energia 10→9/10');
    const npcCheck = runTool(e, 'skill_check', { character_id: 'yuki', attribute: 'carisma', difficulty: 'normal', reason: 'convencer' });
    expect(npcCheck.summary).toMatch(/^🎲 Yuki Sato · Carisma \(convencer\): \d\+\d → /);
  });

  it('o resumo diz ao mestre perks, pensamentos e o que o jogador percebe', () => {
    const e = school();
    e.updateCharacter({ character_id: 'yuki', thoughts: 'esqueceu o trabalho em casa' });
    expect(compileBrief(e)).toContain('pensa: "esqueceu o trabalho em casa"');
    e.extendRuleset({ reason: 'traço', perks: [{ name: 'Telepata', description: '', grants: [{ kind: 'see_thoughts' }] }] });
    e.updateCharacter({ character_id: 'kenji', perks_add: ['telepata'] });
    const brief = compileBrief(e);
    expect(brief).toContain('vida (máx 10, oculto, universal)');
    expect(brief).toContain('pensa (o jogador percebe): "esqueceu o trabalho em casa"');
    expect(brief).toContain('Perks: Telepata (percebe o que os outros pensam)');
    expect(verifierPrompt({ state: brief, changes: [], input: '', narration: '' })).toContain('revelação indevida');
  });
});
