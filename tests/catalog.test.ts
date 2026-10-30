import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalog, setModelCatalog, type RepertoireItem } from '../src/engine/catalog';
import { GameEngine } from '../src/engine/engine';
import { runTool } from '../src/engine/tools';

const ITEMS: RepertoireItem[] = [
  { id: 'SM_Prop_Couch_02', pack: 'office', src: 'office/FBX/SM_Prop_Couch_02.fbx', category: 'objeto', desc: 'sofá de dois lugares de couro preto' },
  { id: 'SM_Prop_Couch_02', pack: 'office', src: 'office/FBX/Unreal/SM_Prop_Couch_02.fbx', category: 'objeto', desc: 'sofá de couro preto (cópia Unreal)' },
  { id: 'SM_Prop_Shoes_01', pack: 'military', src: 'military/SM_Prop_Shoes_01.fbx', category: 'objeto', desc: 'sapato de couro marrom' },
  { id: 'SM_Prop_Pool_Table_01', pack: 'casino', src: 'casino/FBX/SM_Prop_Pool_Table_01.fbx', category: 'objeto', desc: 'mesa de sinuca de feltro verde' },
  { id: 'SM_Prop_Eagle_01', pack: 'war', src: 'war/SM_Prop_Eagle_01.fbx', category: 'objeto', desc: 'emblema de águia com suástica', sensivel: true },
  {
    id: 'SK_Chr_Female_Police',
    pack: 'city',
    src: 'city/FBX/SK_Chr_Female_Police.fbx',
    category: 'personagem',
    desc: 'policial loira de quepe e uniforme azul',
    figure: 'adulta',
    look: 'mulher loira de quepe azul e camisa azul com distintivo',
  },
  { id: 'Run_Forward', pack: 'anim_base_locomotion', src: 'anim/Run_Forward.fbx', category: 'animacao' },
  { id: 'SK_Chr_Male_Police', pack: 'city', src: 'city/FBX/Characters/Unreal_Characters/SK_Chr_Male_Police.fbx', category: 'personagem', desc: 'policial de bigode', figure: 'adulto' },
  { id: 'SM_Item_Playing_Card_01', pack: 'casino', src: 'casino/FBX/SM_Item_Playing_Card_01.fbx', category: 'objeto', desc: 'carta de baralho ás de espadas' },
  { id: 'SM_Item_Letter_02', pack: 'elvenrealm', src: 'elvenrealm/FBX/SM_Item_Letter_02.fbx', category: 'objeto', desc: 'envelope bege aberto com carta escrita' },
  { id: 'SM_Prop_Cup_Styrofoam_01', pack: 'office', src: 'office/FBX/SM_Prop_Cup_Styrofoam_01.fbx', category: 'objeto', desc: 'copo de isopor branco' },
  { id: 'SM_Prop_Glass_Milk', pack: 'xmas', src: 'xmas/FBX/SM_Prop_Glass_Milk.fbx', category: 'objeto', desc: 'copo alto de leite' },
  { id: 'SM_Note_Blank_01', pack: 'prototype', src: 'prototype/FBX/SM_Note_Blank_01.fbx', category: 'objeto', desc: 'bilhete de papel pardo em branco' },
  { id: 'SM_Prop_Rubbish_Paper_03', pack: 'battleroyale', src: 'battleroyale/FBX/SM_Prop_Rubbish_Paper_03.fbx', category: 'objeto', desc: 'papel cinza amassado e dobrado' },
];

afterEach(() => setModelCatalog(null));

describe('catálogo de modelos', () => {
  it('busca pela descrição, sem acento e com plural, com o que se procura antes do detalhe', () => {
    const catalog = new ModelCatalog(ITEMS);
    expect(catalog.search('sofás de couro')[0].id).toBe('office:SM_Prop_Couch_02');
    expect(catalog.search('sofa de couro')[0].desc).toBe('sofá de dois lugares de couro preto');
    expect(catalog.search('mesa de sinuca')[0].id).toBe('casino:SM_Prop_Pool_Table_01');
    expect(catalog.search('policial', { category: 'personagem' }).map((i) => i.id)).toEqual(['city:SK_Chr_Female_Police']);
    expect(catalog.search('policial', { category: 'objeto' })).toEqual([]);
  });

  it('deixa de fora os sensíveis, as animações, a cópia do Unreal e o personagem no esqueleto do Unreal', () => {
    const catalog = new ModelCatalog(ITEMS);
    expect(catalog.search('águia')).toEqual([]);
    expect(catalog.get('anim_base_locomotion:Run_Forward')).toBeUndefined();
    expect(catalog.get('city:SK_Chr_Male_Police')).toBeUndefined();
    expect(catalog.get('office:SM_Prop_Couch_02')?.src).toBe('office/FBX/SM_Prop_Couch_02.fbx');
    expect(catalog.size).toBe(11);
  });

  it('search_models devolve id e descrição, e avisa quando não há catálogo', () => {
    const e = GameEngine.create('teste', 1);
    expect(runTool(e, 'search_models', { query: 'sofá' }).content).toMatch(/indisponível/);
    setModelCatalog(new ModelCatalog(ITEMS));
    const r = runTool(e, 'search_models', { query: 'policial', category: 'personagem' });
    expect(r.ok).toBe(true);
    expect(r.content).toContain('city:SK_Chr_Female_Police');
    expect(r.content).toContain('quepe');
  });

  it('um tipo novo da legenda usa um modelo do catálogo, e o motor confere o id', () => {
    setModelCatalog(new ModelCatalog(ITEMS));
    const e = GameEngine.create('teste', 1);
    const layout = ['######', '#.MM.#', '#....D', '######'];
    const pool = { label: 'mesa de sinuca', like: 'table', merge: true, model: 'casino:SM_Prop_Pool_Table_01' };
    e.createLocation({ id: 'bar', name: 'Bar', description: '', layout, legend: { M: pool } });
    expect(e.state.objectTypes.mesa_de_sinuca).toMatchObject({ model: 'casino:SM_Prop_Pool_Table_01', like: 'table' });
    const bad = runTool(e, 'create_location', { id: 'bar2', name: 'Bar 2', description: '', layout, legend: { M: { label: 'mesa de bilhar', model: 'casino:Nada' } } });
    expect(bad.ok).toBe(false);
    expect(bad.content).toMatch(/search_models/);
    const person = runTool(e, 'create_location', { id: 'bar3', name: 'Bar 3', description: '', layout, legend: { M: { label: 'guarda', model: 'city:SK_Chr_Female_Police' } } });
    expect(person.content).toMatch(/create_characters/);
  });

  it('o visual de um personagem pode vir do catálogo e traz o corpo do modelo', () => {
    setModelCatalog(new ModelCatalog(ITEMS));
    const e = GameEngine.create('teste', 1);
    e.createLocation({ id: 'rua', name: 'Rua', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
    const c = e.createCharacter({ name: 'Rita', role: 'policial', appearance: 'loira de quepe', look: 'city:SK_Chr_Female_Police', location_id: 'rua' });
    expect(c).toMatchObject({ look: 'city:SK_Chr_Female_Police', figure: 'adulta' });
    expect(() => e.createCharacter({ name: 'Ivo', role: 'mesa', appearance: '', look: 'casino:SM_Prop_Pool_Table_01', location_id: 'rua' })).toThrow(/personagem/);
    expect(() => e.updateCharacter({ character_id: 'rita', look: 'city:Inexistente' })).toThrow(/search_models/);
  });

  it('item sem modelo ganha o mais parecido pelo nome e pela descrição, e o mestre vê qual foi', () => {
    const catalog = new ModelCatalog(ITEMS);
    // A descrição desempata o sentido: o envelope, não a carta de baralho.
    expect(catalog.suggest('Carta', 'envelope amarelado')[0].id).toBe('elvenrealm:SM_Item_Letter_02');
    expect(catalog.suggest('Carta', '')[0].id).toBe('casino:SM_Item_Playing_Card_01');
    expect(catalog.suggest('Copo de comprimidos', 'copo de plástico branco')[0].id).toBe('office:SM_Prop_Cup_Styrofoam_01');
    // O bilhete do pacote de rascunho (uma placa de 50 cm) só quando nenhum outro pacote tem papel.
    expect(catalog.suggest('Bilhete amassado', 'Papel de caderno dobrado em quatro')[0].id).toBe('battleroyale:SM_Prop_Rubbish_Paper_03');
    expect(catalog.suggest('Bilhete', '')[0].id).toBe('prototype:SM_Note_Blank_01');
    setModelCatalog(catalog);
    const e = GameEngine.create('teste', 1);
    e.createLocation({ id: 'rua', name: 'Rua', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
    const r = runTool(e, 'create_items', {
      items: [
        { name: 'Carta', description: 'envelope amarelado', holder: { x: 1, y: 1, location_id: 'rua' } },
        { name: 'Copo', description: 'copo alto', holder: { x: 2, y: 1, location_id: 'rua' }, model: 'xmas:SM_Prop_Glass_Milk' },
      ],
    });
    expect(e.state.items.carta.model).toBe('elvenrealm:SM_Item_Letter_02');
    const created = JSON.parse(r.content).created;
    expect(created[0].model).toBe('elvenrealm:SM_Item_Letter_02 (envelope bege aberto com carta escrita), escolhido pelo nome');
    expect(created[0].other_models).toContain('casino:SM_Item_Playing_Card_01 (carta de baralho ás de espadas)');
    expect(created[1].model).toBeUndefined();
  });

  it('cama, carro e cápsula num espaço menor que o tamanho típico são recusados', () => {
    const e = GameEngine.create('teste', 1);
    const bad = runTool(e, 'create_location', { id: 'cela', name: 'Cela', description: '', layout: ['#####', '#b..#', '#...D', '#####'] });
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("cama ('b') em (1,1) ocupa 1×1 tiles e precisa de 1×2, senão vira miniatura: desenhe bb numa linha ou 'b' em 2 linhas seguidas.");
    expect(runTool(e, 'create_location', { id: 'cela', name: 'Cela', description: '', layout: ['#####', '#bb.#', '#...D', '#####'] }).ok).toBe(true);
  });
});
