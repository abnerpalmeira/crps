import type { Era, ObjectType } from './types';

/** As épocas, na ordem da linha do tempo, com o que cada uma cobre (para o mestre escolher). */
export const ERAS: { id: Era; label: string }[] = [
  { id: 'antiguidade', label: 'Antiguidade: Egito, Grécia, Roma' },
  { id: 'medieval', label: 'Idade Média e fantasia medieval: castelos, vikings, samurais' },
  { id: 'colonial', label: 'séculos XVI a XVIII: navegações, colônias, piratas' },
  { id: 'seculo_xix', label: 'século XIX: faroeste, era vitoriana' },
  { id: 'atual', label: 'séculos XX e XXI: o mundo de hoje' },
  { id: 'futuro', label: 'futuro: ficção científica' },
];

export const ERA_IDS = ERAS.map((e) => e.id) as [Era, ...Era[]];

/**
 * Época de cada pacote do catálogo, pelo que ele mostra. Os que não estão aqui (natureza, bichos,
 * ícones, peças genéricas) servem em qualquer época.
 */
const PACKS: Record<Era, string[]> = {
  antiguidade: [
    'ancientegypt', 'ancientempire',
  ],
  medieval: [
    'adventure', 'bowandcrossbow', 'dark_fantasy', 'dark_fortress', 'dungeon', 'dungeons_realms',
    'dwarven_dungeon_map', 'elvenrealm', 'enchantedforest', 'fantasy_characters', 'fantasy_dungeons_map',
    'fantasy_kingdom', 'fantasy_rivals', 'fantasy_village', 'frog_shrine', 'goblin_war_camp', 'knights',
    'legendary_chest', 'maps_dark_fantasy_manor', 'modular_fantasy_hero', 'samurai', 'samurai_empire',
    'viking_realm', 'vikings', 'werewolf',
  ],
  colonial: [
    'pirate', 'pirate_isles_map', 'pirate_realm',
  ],
  seculo_xix: [
    'horror_mansion', 'western', 'western_frontier',
  ],
  atual: [
    'apocalypse', 'apocalypse_wasteland', 'battleroyale', 'bosszombies', 'bubblegumkillstick', 'casino', 'city',
    'city_characters', 'cityzombies', 'coffee_shop', 'construction', 'easter', 'explorer_kit', 'farm',
    'gang_warfare', 'gingerbread', 'halloween_marks', 'hearsekit', 'heist', 'holiday_2025', 'holiday_gnomes',
    'horror_asylum', 'horror_carnival', 'horror_movie_set', 'kaiju', 'kids', 'military', 'military_warehouse',
    'nightclubs', 'office', 'palm_city', 'plushies', 'police_station', 'pride', 'pride_weapons', 'prison_map',
    'pro_racer', 'quadbike', 'santa', 'shopping_plaza_map', 'shops', 'snow_kit', 'spy_kit', 'street_racer',
    'stuntplane', 'town', 'valentines', 'war', 'war_map', 'waterguns_unreal', 'wheelchair',
    'woodland_apocalypse_map', 'xmas',
  ],
  futuro: [
    'cybercity', 'mech', 'scifi_city', 'scifi_horror', 'scifi_outpost_map', 'scifi_space', 'scifiworlds',
  ],
};

export const PACK_ERA: Record<string, Era> = Object.fromEntries(
  (Object.entries(PACKS) as [Era, string[]][]).flatMap(([era, packs]) => packs.map((p) => [p, era])),
);

/**
 * Quanto um modelo do pacote serve na época: inteiro na mesma (ou atemporal), menos quanto mais
 * longe na linha do tempo. Sem época, como antes: tudo serve.
 */
export function eraFit(pack: string, era: Era | undefined): number {
  const own = PACK_ERA[pack];
  if (!era || !own) return 1;
  const d = Math.abs(ERA_IDS.indexOf(own) - ERA_IDS.indexOf(era));
  return d === 0 ? 1 : d === 1 ? 0.6 : 0.25;
}

/**
 * Pacotes com gente comum de cada época (camponeses, nobres, soldados, mercadores), que abrem a
 * lista de visuais do mestre. Os outros pacotes da época, de fantasia mais exótica (elfos, anões,
 * lordes sombrios), vêm depois, e todos aparecem na busca.
 */
export const ERA_PEOPLE: Partial<Record<Era, string[]>> = {
  antiguidade: ['ancientempire'],
  medieval: ['fantasy_kingdom', 'fantasy_characters', 'knights', 'vikings', 'adventure'],
  colonial: ['pirate'],
  seculo_xix: ['western_frontier', 'western', 'horror_mansion'],
  futuro: ['scifi_city', 'scifi_space', 'cybercity'],
};

/**
 * Modelo do catálogo para cada tipo de móvel, por época, escolhido olhando as miniaturas. A época
 * atual usa os da biblioteca (scripts/assets/synty.json).
 */
export const ERA_FIXTURES: Partial<Record<Era, Record<string, string>>> = {
  antiguidade: {
    armchair: 'ancientempire:SM_Prop_Seat_Chair_03',
    bar_stool: 'ancientegypt:SM_Prop_Chair_02',
    bed: 'ancientegypt:SM_Prop_Bed_02',
    bench: 'ancientempire:SM_Prop_Bench_01',
    chair: 'ancientempire:SM_Prop_Seat_Chair_02',
    coffee_table: 'ancientegypt:SM_Prop_Table_01',
    fence: 'ancientegypt:SM_Bld_Fence_02',
    fountain: 'ancientempire:SM_Prop_Fountain_04',
    nightstand: 'ancientempire:SM_Prop_Table_05',
    office_desk: 'ancientempire:SM_Prop_Table_08',
    rug: 'ancientempire:SM_Prop_Rug_04',
    shelf: 'ancientempire:SM_Prop_Shelf_Scroll_01',
    sofa: 'ancientempire:SM_Prop_Seat_Bench_02',
    statue: 'ancientempire:SM_Prop_Statue_02',
    table: 'ancientempire:SM_Prop_Table_08',
    toilet: 'ancientempire:SM_Prop_Toilet_01',
    trash_can: 'ancientempire:SM_Prop_Basket_01',
  },
  medieval: {
    armchair: 'fantasy_kingdom:SM_Prop_Chair_Fancy_04',
    bar_stool: 'fantasy_village:SM_Prop_Stool_01',
    bathtub: 'fantasy_kingdom:SM_Prop_BathTub_01',
    bed: 'fantasy_kingdom:SM_Prop_Bed_04',
    bench: 'fantasy_kingdom:SM_Prop_Bench_Seat_01',
    chair: 'fantasy_kingdom:SM_Prop_Chair_Wood_01',
    coat_rack: 'fantasy_village:SM_Prop_Clothes_Rack_01',
    coffee_table: 'fantasy_kingdom:SM_Prop_Table_Wood_09',
    counter: 'fantasy_kingdom:SM_Prop_Bar_03',
    display_case: 'fantasy_kingdom:SM_Prop_Jewellery_Display_02',
    dresser: 'fantasy_kingdom:SM_Prop_Dresser_02',
    fence: 'fantasy_kingdom:SM_Prop_Fence_01',
    fireplace: 'dungeons_realms:SM_Env_Dwarf_Wall_Fireplace_01',
    floor_lamp: 'dark_fortress:SM_Prop_Candle_Stand_01',
    fountain: 'fantasy_kingdom:SM_Env_Fountain_Statue_01',
    hospital_bed: 'fantasy_kingdom:SM_Prop_Bed_04',
    kitchen_counter: 'fantasy_kingdom:SM_Prop_Cabinet_04_Preset',
    lectern: 'fantasy_kingdom:SM_Prop_Church_Lectern_01',
    locker: 'fantasy_village:SM_Prop_Cabinet_02',
    nightstand: 'fantasy_kingdom:SM_Prop_Side_Table_03',
    office_desk: 'fantasy_village:SM_Prop_Desk_01',
    pedestal: 'dungeon:SM_Env_Pillar_Square_Simple_05',
    piano: 'dark_fantasy:SM_Prop_Organ_01',
    plant: 'fantasy_kingdom:SM_Env_Planter_Pedestal_01_Preset_05',
    rug: 'fantasy_village:SM_Prop_Rug_01',
    shelf: 'fantasy_dungeons_map:SM_Prop_Bookcase_01',
    sink: 'fantasy_kingdom:SM_Prop_Sink_01',
    sofa: 'fantasy_village:SM_Prop_Sofa_03',
    statue: 'fantasy_kingdom:SM_Prop_Statue_Knight_01',
    stove: 'fantasy_kingdom:SM_Prop_Cooking_Block_01',
    street_lamp: 'fantasy_kingdom:SM_Prop_Street_Lamp_01',
    table: 'fantasy_kingdom:SM_Prop_Table_Wood_10',
    teacher_desk: 'fantasy_village:SM_Prop_Desk_01',
    tent: 'fantasy_kingdom:SM_Bld_Tent_Small_01',
    toilet: 'fantasy_kingdom:SM_Prop_Toilet_03',
    trash_can: 'fantasy_village:SM_Prop_Basket_04',
    wardrobe: 'fantasy_kingdom:SM_Prop_Wardrobe_01_Preset',
    workbench: 'fantasy_kingdom:SM_Prop_Workbench_01_Preset',
  },
  colonial: {
    armchair: 'pirate_realm:SM_Prop_Chair_02',
    bar_stool: 'pirate:SM_Prop_Stool_01',
    bed: 'pirate_realm:SM_Prop_Bed_01',
    bench: 'pirate:SM_Prop_Bench_01',
    chair: 'pirate_realm:SM_Prop_Chair_02',
    coffee_table: 'pirate_realm:SM_Prop_Desk_01',
    fence: 'pirate:SM_Prop_Fence_02',
    fountain: 'pirate:SM_Prop_Fountain_01',
    lectern: 'pirate_realm:SM_Prop_Desk_03',
    nightstand: 'pirate_realm:SM_Prop_Table_04',
    office_desk: 'pirate_realm:SM_Prop_Desk_02',
    rug: 'pirate_realm:SM_Prop_Rug_01',
    sofa: 'pirate:SM_Prop_Bench_01',
    table: 'pirate:SM_Prop_Table_01',
    tent: 'pirate:SM_Bld_Tent_02',
  },
  seculo_xix: {
    armchair: 'horror_mansion:SM_Prop_ArmChair_01',
    bar_stool: 'horror_mansion:SM_Prop_Stool_01',
    bathtub: 'western:SM_Prop_Barrel_Half_01',
    bed: 'western:SM_Prop_Bed_02',
    bench: 'western:SM_Prop_Bench_01',
    chair: 'horror_mansion:SM_Prop_Chair_02',
    coffee_table: 'western:SM_Prop_Table_01',
    dresser: 'western:SM_Prop_Dresser_01',
    fence: 'western:SM_Bld_Fence_01',
    fireplace: 'horror_mansion:SM_Bld_Fireplace_01',
    floor_lamp: 'horror_mansion:SM_Prop_Candle_Stand_03',
    fountain: 'horror_mansion:SM_Env_Fountain_02',
    kitchen_counter: 'horror_mansion:SM_Prop_Kitchen_Bench_01',
    lectern: 'western:SM_Prop_Church_Podium_01',
    locker: 'horror_mansion:SM_Prop_Wardrobe_02',
    nightstand: 'horror_mansion:SM_Prop_Side_Table_01',
    office_desk: 'western:SM_Prop_Desk_01',
    plant: 'horror_mansion:SM_Env_Plant_Fern_02',
    rug: 'horror_mansion:SM_Prop_Rug_01',
    shelf: 'horror_mansion:SM_Bld_Bookshelf_02',
    sink: 'horror_mansion:SM_Prop_Sink_01',
    sofa: 'horror_mansion:SM_Prop_Couch_02',
    stove: 'horror_mansion:SM_Prop_Stove_01',
    table: 'western_frontier:SM_Prop_Table_01',
    tent: 'western_frontier:SM_Bld_Tent_02',
    toilet: 'horror_mansion:SM_Prop_Toilet_01',
    trash_can: 'western:SM_Prop_Basket_01',
    wardrobe: 'horror_mansion:SM_Prop_Wardrobe_01',
  },
  futuro: {
    armchair: 'scifi_horror:SM_Prop_Chair_01',
    bar_stool: 'scifi_city:SM_Prop_BarChair_01',
    bed: 'scifi_space:SM_Prop_Bed_03',
    chair: 'scifi_city:SM_Prop_Office_Chair_01',
    coffee_table: 'scifi_space:SM_Prop_Table_01',
    counter: 'scifi_city:SM_Prop_table_01',
    fence: 'scifi_outpost_map:SM_Bld_Fence_02',
    locker: 'scifi_horror:SM_Prop_Locker_01',
    nightstand: 'scifi_city:SM_Prop_Table_Small_01',
    office_desk: 'scifi_horror:SM_Prop_Desk_02',
    plant: 'scifi_city:SM_Prop_Plant_Vase_02',
    rug: 'cybercity:SM_Prop_Rug_02',
    sink: 'scifi_space:SM_Prop_Sink_01',
    sofa: 'scifi_horror:SM_Prop_Bench_01',
    statue: 'scifi_horror:SM_Gen_Prop_Statue_05',
    street_lamp: 'scifi_city:SM_Prop_Streetlight_01',
    table: 'scifi_space:SM_Prop_Table_01',
    toilet: 'scifi_space:SM_Prop_Toilet_01',
    trash_can: 'scifi_city:SM_Prop_TrashCan_01',
    wardrobe: 'scifi_horror:SM_Prop_Cabinet_03',
  },
};

/**
 * O visual de um móvel na época do lugar: o modelo que o mestre deu ao tipo vale sempre; senão, o
 * da tabela da época para o tipo ou para o parecido de onde ele veio. null = fica o da biblioteca.
 */
export function eraFixtureModel(chain: ObjectType[], era: Era | undefined): string | null {
  const own = chain.find((t) => t.model)?.model;
  if (own) return own;
  const table = era ? ERA_FIXTURES[era] : undefined;
  return (table && chain.map((t) => table[t.id]).find(Boolean)) || null;
}

/** O visual do tipo destoa da época do lugar: o padrão é de outra época e não há modelo desta. */
export function outOfEra(chain: ObjectType[], era: Era | undefined): boolean {
  if (!era || chain.some((t) => t.wall) || eraFixtureModel(chain, era)) return false;
  const own = chain.map((t) => t.era).find(Boolean) ?? 'atual';
  return own !== 'atemporal' && own !== era;
}
