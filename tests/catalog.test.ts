import { afterEach, describe, expect, it } from 'vitest';
import { ModelCatalog, portableSize, setModelCatalog, type RepertoireItem } from '../src/engine/catalog';
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

  it('item é o que cabe na mão: a bacia de pedra sobre pedestal não vira a bacia de latão da criada', () => {
    const rows: RepertoireItem[] = [
      { id: 'SM_Env_Stone_Vessel_01', pack: 'dungeon', src: 'd/1.fbx', category: 'objeto', desc: 'bacia de pedra lascada sobre pedestal grosso', size: [1.438, 1.347, 1.245] },
      { id: 'SM_Env_Basin_02', pack: 'dungeon', src: 'd/2.fbx', category: 'objeto', desc: 'bacia de pedra rachada' },
      { id: 'SM_Prop_Brass_Bowl_01', pack: 'fantasy_village', src: 'f/1.fbx', category: 'objeto', desc: 'bacia rasa de latão', size: [0.42, 0.12, 0.42] },
      { id: 'SM_Prop_BathTub_01', pack: 'fantasy_kingdom', src: 'f/2.fbx', category: 'objeto', desc: 'tina de banho de madeira', size: [0.8, 0.62, 1.7] },
      { id: 'SM_Wep_Spear_01', pack: 'knights', src: 'k/1.fbx', category: 'arma', desc: 'lança de madeira com ponta de ferro', size: [0.1, 2.4, 0.1] },
      { id: 'SM_Prop_Broom_01', pack: 'fantasy_village', src: 'f/3.fbx', category: 'objeto', desc: 'vassoura de palha', size: [0.3, 1.5, 0.1] },
      { id: 'SM_Item_Bucket_01_Handle', pack: 'fantasy_kingdom', src: 'f/4.fbx', category: 'objeto', desc: 'alça curva de madeira do balde', size: [0.24, 0.18, 0.45] },
      { id: 'SM_Prop_Bird_Bath_01', pack: 'dark_fortress', src: 'd/3.fbx', category: 'objeto', desc: 'pássaro de pedra numa bacia', size: [0.3, 0.3, 0.3] },
      { id: 'SM_Item_Bucket_01', pack: 'fantasy_kingdom', src: 'f/5.fbx', category: 'objeto', desc: 'balde de madeira escura com aros', size: [0.41, 0.39, 0.4] },
    ];
    // Uma medida longa passa (lança, vassoura); duas grandes, não (a bacia de 1,4 m, a tina).
    expect(portableSize([0.1, 2.4, 0.1], 'arma')).toBe(true);
    expect(portableSize([0.3, 1.5, 0.1], 'objeto')).toBe(true);
    expect(portableSize([1.438, 1.347, 1.245], 'objeto')).toBe(false);
    expect(portableSize([0.8, 0.62, 1.7], 'objeto')).toBe(false);
    const catalog = new ModelCatalog(rows);
    const basins = catalog.suggest('Bacia de latão', 'bacia de latão com água morna').map((i) => i.id);
    expect(basins[0]).toBe('fantasy_village:SM_Prop_Brass_Bowl_01');
    expect(basins).not.toContain('dungeon:SM_Env_Stone_Vessel_01');
    // A peça de outro modelo (a alça do balde) não é item, e a descrição que abre com o que se procura
    // vem antes da que só o cita.
    expect(catalog.suggest('Balde', '').map((i) => i.id)).toEqual(['fantasy_kingdom:SM_Item_Bucket_01']);
    expect(catalog.suggest('Bacia', '')[0].id).toBe('fantasy_village:SM_Prop_Brass_Bowl_01');
    // Sem medida, peça de cenário (SM_Env) não se carrega: para "bacia de pedra", só a de latão.
    expect(catalog.suggest('Bacia de pedra', '').map((i) => i.id)).not.toContain('dungeon:SM_Env_Basin_02');
    setModelCatalog(catalog);
    const e = GameEngine.create('teste', 1);
    e.createLocation({ id: 'rua', name: 'Rua', description: '', outdoor: true, layout: ['.....', '.....', '.....'] });
    const big = runTool(e, 'create_items', {
      items: [{ name: 'Bacia', description: '', holder: { x: 1, y: 1, location_id: 'rua' }, model: 'dungeon:SM_Env_Stone_Vessel_01' }],
    });
    expect(big.ok).toBe(false);
    expect(big.content).toContain('1,4 × 1,3 × 1,2 m) não cabe na mão de ninguém');
    const found = runTool(e, 'search_models', { query: 'bacia' }).content;
    expect(found).toContain('dungeon:SM_Env_Stone_Vessel_01: bacia de pedra lascada sobre pedestal grosso (objeto, 1,4 × 1,3 × 1,2 m, não cabe na mão)');
    expect(found).toContain('fantasy_village:SM_Prop_Brass_Bowl_01: bacia rasa de latão (objeto, 0,4 × 0,1 × 0,4 m)');
  });

  it('cama, carro e cápsula num espaço menor que o tamanho típico são recusados', () => {
    const e = GameEngine.create('teste', 1);
    const bad = runTool(e, 'create_location', { id: 'cela', name: 'Cela', description: '', layout: ['#####', '#b..#', '#...D', '#####'] });
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("cama ('b') em (1,1) ocupa 1×1 tiles e precisa de 1×2, senão vira miniatura: desenhe bb numa linha ou 'b' em 2 linhas seguidas.");
    expect(runTool(e, 'create_location', { id: 'cela', name: 'Cela', description: '', layout: ['#####', '#bb.#', '#...D', '#####'] }).ok).toBe(true);
  });
});
