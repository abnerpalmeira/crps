import { afterEach, describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { bodyPose } from '../src/engine/body';
import { ModelCatalog, eraLooks, setBaseLooks, setModelCatalog, type RepertoireItem } from '../src/engine/catalog';
import { GameEngine } from '../src/engine/engine';
import { ERA_FIXTURES, eraFit, eraFixtureModel, outOfEra } from '../src/engine/eras';
import { typeChain } from '../src/engine/objects';
import { runTool } from '../src/engine/tools';

const item = (pack: string, id: string, category: string, desc: string, extra: Partial<RepertoireItem> = {}): RepertoireItem => ({
  id,
  pack,
  src: `${pack}/FBX/${id}.fbx`,
  category,
  desc,
  ...extra,
});

/** Um pedaço do repertório: a mesma vela e gente de duas épocas. */
const REPERTOIRE = [
  item('town', 'SM_Prop_Candle_01', 'objeto', 'vela branca'),
  item('fantasy_village', 'SM_Prop_Candle_02', 'objeto', 'vela branca'),
  item('fantasy_kingdom', 'SK_Chr_Maid_01', 'personagem', 'criada', { figure: 'adulta', look: 'vestido azul e avental branco' }),
  item('fantasy_kingdom', 'SK_Chr_Noble_01', 'personagem', 'nobre', { figure: 'adulto', look: 'gibão de veludo verde e capa' }),
  item('town', 'SK_Chr_Mother_01', 'personagem', 'mãe', { figure: 'adulta', look: 'jeans e blusa listrada' }),
];

const BASE = [{ id: 'mother_1', figure: 'adulta', look: 'jeans e blusa listrada' }];

/** Quarto de castelo com a época da campanha medieval. */
function castle(): GameEngine {
  const e = GameEngine.create('Um castelo.', 3);
  runTool(e, 'define_ruleset', {
    name: 'Medieval',
    attributes: [
      { name: 'Vigor', description: 'força' },
      { name: 'Astúcia', description: 'esperteza' },
    ],
    resources: [],
    era: 'medieval',
  });
  return e;
}

afterEach(() => {
  setModelCatalog(null);
  setBaseLooks([]);
});

describe('épocas', () => {
  it('o modelo de outra época pesa menos, quanto mais longe na linha do tempo', () => {
    expect(eraFit('fantasy_kingdom', 'medieval')).toBe(1);
    expect(eraFit('nature', 'medieval')).toBe(1);
    expect(eraFit('pirate', 'medieval')).toBe(0.6);
    expect(eraFit('town', 'medieval')).toBe(0.25);
    expect(eraFit('town', undefined)).toBe(1);
  });

  it('cada móvel tem o visual da época do lugar, e o do mestre vale mais', () => {
    expect(eraFixtureModel(typeChain(null, 'locker'), 'medieval')).toBe(ERA_FIXTURES.medieval!.locker);
    expect(eraFixtureModel(typeChain(null, 'locker'), 'atual')).toBeNull();
    expect(eraFixtureModel(typeChain(null, 'locker'), undefined)).toBeNull();
    // Um tipo do mestre parecido com a cama usa a cama da época; com modelo próprio, o dele.
    const world = { objectTypes: { cama_dossel: { id: 'cama_dossel', label: 'cama de dossel', like: 'bed', bed: true, seat: true } } };
    expect(eraFixtureModel(typeChain(world, 'cama_dossel'), 'medieval')).toBe(ERA_FIXTURES.medieval!.bed);
    const own = { objectTypes: { cama_dossel: { ...world.objectTypes.cama_dossel, model: 'fantasy_village:SM_Prop_Bed_Canopy_01' } } };
    expect(eraFixtureModel(typeChain(own, 'cama_dossel'), 'medieval')).toBe('fantasy_village:SM_Prop_Bed_Canopy_01');
    // Televisão não existe na Idade Média; barril serve em qualquer época; porta é desenhada.
    expect(outOfEra(typeChain(null, 'tv'), 'medieval')).toBe(true);
    expect(outOfEra(typeChain(null, 'barrel'), 'medieval')).toBe(false);
    expect(outOfEra(typeChain(null, 'door'), 'medieval')).toBe(false);
  });

  it('o local guarda a época e o motor avisa do móvel que não tem visual dela', () => {
    const e = castle();
    expect(e.state.era).toBe('medieval');
    const r = runTool(e, 'create_location', {
      id: 'quarto',
      name: 'Quarto',
      description: '',
      layout: ['########', '#b..k..#', '#b.....#', '#..v.r.#', '#......#', '####D###'],
      legend: { v: 'tv', r: 'barrel' },
    });
    expect(r.ok).toBe(true);
    expect(e.state.locations.quarto.era).toBe('medieval');
    const warnings = (r.data as { warnings: string[] }).warnings;
    expect(warnings.find((w) => w.startsWith('Sem visual da época'))).toContain('televisão aparece como é hoje');
    expect(warnings.join(' ')).not.toContain('barril');
    // Um lugar de outra época (viagem no tempo) fica com a dele.
    runTool(e, 'create_location', { id: 'lab', name: 'Laboratório', description: '', layout: ['#####', '#...#', '#...#', '##D##'], era: 'futuro' });
    expect(e.state.locations.lab.era).toBe('futuro');
  });

  it('itens e buscas trazem primeiro os da época, e a lista de visuais é a dela', () => {
    setModelCatalog(new ModelCatalog(REPERTOIRE));
    setBaseLooks(BASE);
    expect(eraLooks('medieval').map((l) => l.id)).toEqual(['fantasy_kingdom:SK_Chr_Maid_01', 'fantasy_kingdom:SK_Chr_Noble_01']);
    expect(eraLooks('atual')).toEqual(BASE);
    expect(eraLooks(undefined)).toEqual(BASE);
    // Sem visuais da época no catálogo, ficam os de hoje.
    expect(eraLooks('futuro')).toEqual(BASE);

    const e = castle();
    runTool(e, 'create_location', { id: 'quarto', name: 'Quarto', description: '', layout: ['#####', '#...#', '#.t.#', '#...#', '##D##'] });
    runTool(e, 'create_items', { items: [{ name: 'Vela', description: 'vela branca', holder: { fixture_id: 'quarto/mesa-1' } }] });
    expect(Object.values(e.state.items)[0].model).toBe('fantasy_village:SM_Prop_Candle_02');
    const found = runTool(e, 'search_models', { query: 'vela branca' }).data as string[];
    expect(found[0]).toMatch(/^fantasy_village:/);
  });

  it('define_ruleset traz os visuais da época, e visual de outra época vira aviso', () => {
    setModelCatalog(new ModelCatalog(REPERTOIRE));
    setBaseLooks(BASE);
    const e = GameEngine.create('Um castelo.', 3);
    const r = runTool(e, 'define_ruleset', { name: 'Medieval', attributes: [{ name: 'Vigor', description: '' }, { name: 'Astúcia', description: '' }], resources: [], era: 'medieval' });
    expect((r.data as { looks: string[] }).looks).toEqual([
      'fantasy_kingdom:SK_Chr_Maid_01 (adulta): vestido azul e avental branco',
      'fantasy_kingdom:SK_Chr_Noble_01 (adulto): gibão de veludo verde e capa',
    ]);
    runTool(e, 'create_location', { id: 'quarto', name: 'Quarto', description: '', layout: ['#####', '#...#', '##D##'] });
    const made = runTool(e, 'create_characters', {
      characters: [
        { name: 'Agnes', role: 'criada', appearance: '', look: 'mother_1' },
        { name: 'Henrik Valmont', role: 'nobre', appearance: '', look: 'fantasy_kingdom:SK_Chr_Noble_01', is_player: true },
      ],
    }).data as { notes?: string[] };
    expect(made.notes).toEqual(['Agnes: o visual mother_1 é de outra época (atual) e a campanha é medieval. Se não for de propósito, troque com update_character look por um da época.']);
    const fixed = runTool(e, 'update_character', { character_id: 'agnes', look: 'fantasy_kingdom:SK_Chr_Maid_01' }).data as { note?: string };
    expect(fixed.note).toBeUndefined();
    // A história vai para outra época: a campanha muda, e o resultado traz os visuais dela.
    const ext = runTool(e, 'extend_ruleset', { era: 'atual', reason: 'viagem no tempo' });
    expect(e.state.era).toBe('atual');
    expect((ext.data as { looks: string[] }).looks).toEqual(['mother_1 (adulta): jeans e blusa listrada']);
  });

  it('quem senta na beirada da cama fica sentado nela; sentado sem assento é no chão', () => {
    const e = castle();
    runTool(e, 'create_location', { id: 'quarto', name: 'Quarto', description: '', layout: ['######', '#bb..#', '#....#', '###D##'] });
    runTool(e, 'create_characters', { characters: [{ name: 'Henrik Valmont', role: 'nobre', appearance: '', is_player: true, position: { seat: 'quarto/cama-1' } }] });
    const henrik = () => e.state.characters.henrik;
    expect(bodyPose(e.state, henrik())).toBe('deitado');
    expect(compileBrief(e)).toContain('deitado(a) em cama-1');
    runTool(e, 'update_character', { character_id: 'henrik', pose: 'sentado' });
    expect(henrik().seatId).toBe('quarto/cama-1');
    expect(bodyPose(e.state, henrik())).toBe('sentado');
    expect(compileBrief(e)).toContain('sentado(a) na beirada de cama-1');
    runTool(e, 'update_character', { character_id: 'henrik', pose: 'deitado' });
    expect(bodyPose(e.state, henrik())).toBe('deitado');
    // Levantar e sentar de novo, agora sem assento: no chão.
    runTool(e, 'update_character', { character_id: 'henrik', pose: 'de_pe' });
    runTool(e, 'update_character', { character_id: 'henrik', pose: 'sentado' });
    expect(henrik().seatId).toBeNull();
    expect(compileBrief(e)).toContain('sentado(a) no chão');
  });

  it('save antigo, sem época, fica como era', () => {
    const e = GameEngine.create('Uma escola.', 3);
    runTool(e, 'create_location', { id: 'sala', name: 'Sala', description: '', layout: ['#####', '#...#', '#.v.#', '#...#', '##D##'], legend: { v: 'tv' } });
    expect(e.state.era).toBeUndefined();
    expect(e.state.locations.sala.era).toBeUndefined();
    const loaded = GameEngine.fromJSON(e.toJSON());
    expect(loaded.state.era).toBeUndefined();
  });
});
