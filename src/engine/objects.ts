import { fold, slugify } from './text';
import type { ObjectType, WorldState } from './types';

const LIBRARY: ObjectType[] = [
  // Os de sempre, com caractere fixo.
  { id: 'door', char: 'D', label: 'porta', slug: 'porta', passable: true, wall: true, merge: true, facing: 'interior', exit: 'door', article: 'a' },
  { id: 'window', char: 'W', label: 'janela', slug: 'janela', wall: true, merge: true, facing: 'interior', article: 'a' },
  { id: 'board', char: 'B', label: 'quadro-negro', slug: 'quadro', wall: true, merge: true, facing: 'interior', surface: 0.97, article: 'o' },
  { id: 'teacher_desk', char: 'T', label: 'mesa do professor', slug: 'mesa-prof', merge: true, facing: 'away_board', table: true, surface: 0.81, article: 'a' },
  { id: 'desk', char: 'd', label: 'carteira (mesa + cadeira)', slug: 'carteira', seat: true, facing: 'board', table: true, surface: 0.76, article: 'a' },
  { id: 'chair', char: 'c', label: 'cadeira', slug: 'cadeira', seat: true, facing: 'table', surface: 0.48, article: 'a' },
  { id: 'table', char: 't', label: 'mesa', slug: 'mesa', merge: true, table: true, surface: 0.79, article: 'a' },
  { id: 'shelf', char: 's', label: 'estante', slug: 'estante', merge: true, facing: 'open_side', surface: 1.02, article: 'a' },
  { id: 'locker', char: 'k', label: 'armário', slug: 'armario', facing: 'open_side', surface: 1.92, article: 'o' },
  { id: 'plant', char: 'p', label: 'vaso de planta', slug: 'planta', article: 'o' },
  { id: 'bed', char: 'b', label: 'cama', slug: 'cama', seat: true, bed: true, merge: true, facing: 'lengthwise', surface: 0.52, article: 'a' },
  { id: 'sofa', char: 'S', label: 'sofá', slug: 'sofa', seat: true, merge: true, facing: 'open_side', surface: 0.44, article: 'o' },
  { id: 'counter', char: 'C', label: 'balcão', slug: 'balcao', merge: true, facing: 'open_side', table: true, surface: 1.05, article: 'o' },
  { id: 'crate', char: 'x', label: 'caixa', slug: 'caixa', surface: 0.62, article: 'a' },
  { id: 'elevator', char: 'E', label: 'elevador', slug: 'elevador', passable: true, wall: true, merge: true, facing: 'interior', exit: 'floors', article: 'o' },
  { id: 'stairs', char: 'Z', label: 'escada', slug: 'escada', passable: true, wall: true, facing: 'interior', exit: 'floors', article: 'a' },

  // Casa.
  { id: 'armchair', label: 'poltrona', seat: true, facing: 'open_side', surface: 0.45, height: 1, color: '#8a5a44', article: 'a' },
  { id: 'coffee_table', size: '1×1', label: 'mesa de centro', merge: true, table: true, surface: 0.45, height: 0.45, color: '#9b6b43', article: 'a' },
  { id: 'tv', label: 'televisão', facing: 'open_side', surface: 0.55, height: 1.3, color: '#22252b', article: 'a' },
  { id: 'wardrobe', size: '1×1', label: 'guarda-roupa', merge: true, facing: 'open_side', height: 2, color: '#7b5636', article: 'o' },
  { id: 'dresser', label: 'cômoda', merge: true, facing: 'open_side', surface: 0.9, height: 0.9, color: '#8b6040', article: 'a' },
  { id: 'nightstand', label: 'criado-mudo', facing: 'open_side', surface: 0.55, height: 0.55, color: '#8b6040', article: 'o' },
  { id: 'floor_lamp', label: 'abajur de chão', height: 1.6, color: '#e8d9b0', article: 'o' },
  { id: 'rug', size: '2×3', label: 'tapete', passable: true, merge: true, height: 0.02, color: '#7b5a6b', article: 'o' },
  { id: 'fireplace', size: '2×1', label: 'lareira', merge: true, facing: 'open_side', surface: 1.1, height: 1.3, color: '#8d8a84', article: 'a' },
  { id: 'piano', size: '2×1', label: 'piano', merge: true, facing: 'lengthwise', surface: 1, height: 1.2, color: '#1e1c1c', article: 'o' },
  { id: 'stove', label: 'fogão', facing: 'open_side', surface: 0.9, height: 0.9, color: '#d8d8d8', article: 'o' },
  { id: 'fridge', label: 'geladeira', facing: 'open_side', height: 1.9, color: '#e6e6e6', article: 'a' },
  { id: 'kitchen_counter', size: '3×1', label: 'bancada de cozinha', merge: true, facing: 'open_side', table: true, surface: 0.92, height: 0.92, color: '#c9c3b6', article: 'a' },
  { id: 'sink', label: 'pia', facing: 'open_side', surface: 0.9, height: 0.9, color: '#d8dde2', article: 'a' },
  { id: 'toilet', label: 'vaso sanitário', seat: true, facing: 'open_side', height: 0.8, color: '#f2f2f2', article: 'o' },
  { id: 'bathtub', size: '2×1', label: 'banheira', merge: true, facing: 'open_side', height: 0.6, color: '#f2f2f2', article: 'a' },

  // Escritório, loja, bar, restaurante.
  { id: 'office_desk', size: '2×1', label: 'escrivaninha', merge: true, facing: 'open_side', table: true, surface: 0.76, height: 0.76, color: '#9b6b43', article: 'a' },
  { id: 'filing_cabinet', label: 'arquivo de aço', facing: 'open_side', surface: 1.3, height: 1.3, color: '#7d848c', article: 'o' },
  { id: 'water_cooler', label: 'bebedouro', height: 1.2, color: '#cfe3f0', article: 'o' },
  { id: 'coat_rack', label: 'cabideiro', height: 1.8, color: '#5a4030', article: 'o' },
  { id: 'store_shelf', size: '3×1', label: 'gôndola', merge: true, facing: 'open_side', surface: 1.4, height: 1.6, color: '#c8c8c8', article: 'a' },
  { id: 'display_fridge', label: 'expositor refrigerado', merge: true, facing: 'open_side', height: 2, color: '#d0e4ee', article: 'o' },
  { id: 'bar_stool', label: 'banqueta', seat: true, facing: 'table', surface: 0.75, height: 0.75, color: '#5b6472', article: 'a' },

  // Museu, palco, hospital.
  { id: 'display_case', size: '3×1', label: 'vitrine', merge: true, facing: 'open_side', surface: 1, height: 1.4, color: '#bfe3f2', article: 'a' },
  { id: 'pedestal', label: 'pedestal', surface: 1.05, height: 1.05, color: '#e4dccd', article: 'o' },
  { id: 'painting', label: 'quadro na parede', wall: true, merge: true, facing: 'interior', color: '#b0873f', article: 'o' },
  { id: 'statue', label: 'estátua', height: 2, color: '#c9c3b6', article: 'a' },
  { id: 'rope_barrier', label: 'cordão de isolamento', height: 1, color: '#9c1f1f', article: 'o' },
  { id: 'bench', size: '2×1', label: 'banco', seat: true, merge: true, facing: 'open_side', surface: 0.45, height: 0.45, color: '#8b6040', article: 'o' },
  { id: 'lectern', label: 'púlpito', facing: 'open_side', surface: 1.1, height: 1.15, color: '#7b5636', article: 'o' },
  { id: 'screen', label: 'telão', wall: true, merge: true, facing: 'interior', color: '#2a2f3b', article: 'o' },
  { id: 'hospital_bed', size: '1×2', label: 'cama hospitalar', seat: true, bed: true, merge: true, facing: 'lengthwise', surface: 0.6, height: 0.6, color: '#e6e6e6', article: 'a' },

  // Ficção científica.
  { id: 'control_panel', size: '2×1', label: 'painel de controle', merge: true, facing: 'open_side', table: true, surface: 1, height: 1.1, color: '#3b4148', article: 'o' },
  { id: 'workbench', size: '2×1', label: 'bancada de trabalho', merge: true, facing: 'open_side', table: true, surface: 0.95, height: 0.95, color: '#6b6f75', article: 'a' },
  { id: 'hatch', label: 'escotilha', passable: true, wall: true, facing: 'interior', exit: 'door', color: '#8b939c', article: 'a' },
  { id: 'server_rack', size: '1×1', label: 'rack de servidores', merge: true, facing: 'open_side', height: 2, color: '#1f2329', article: 'o' },
  { id: 'cryo_pod', size: '2×3', label: 'cápsula', merge: true, facing: 'lengthwise', height: 2, color: '#cfe3f0', article: 'a' },

  // Fantasia e época.
  { id: 'barrel', label: 'barril', surface: 0.9, height: 0.9, color: '#8b6040', article: 'o' },
  { id: 'chest', label: 'baú', facing: 'open_side', surface: 0.6, height: 0.6, color: '#7b5636', article: 'o' },
  { id: 'throne', label: 'trono', seat: true, facing: 'open_side', height: 1.8, color: '#b0873f', article: 'o' },
  { id: 'anvil', label: 'bigorna', surface: 0.8, height: 0.8, color: '#3b4148', article: 'a' },
  { id: 'forge', size: '2×2', label: 'forja', merge: true, facing: 'open_side', height: 1.2, color: '#5a3a2a', article: 'a' },
  { id: 'cauldron', label: 'caldeirão', height: 0.8, color: '#2a2a2a', article: 'o' },
  { id: 'hay_bale', label: 'fardo de feno', seat: true, surface: 0.8, height: 0.8, color: '#d8b35a', article: 'o' },
  { id: 'well', size: '2×2', label: 'poço', merge: true, height: 1, color: '#8d8a84', article: 'o' },
  { id: 'gate', label: 'portão', passable: true, wall: true, merge: true, facing: 'interior', exit: 'door', color: '#5a4030', article: 'o' },

  // Ao ar livre.
  { id: 'tree', label: 'árvore', height: 4, color: '#4f7a3a', article: 'a' },
  { id: 'bush', label: 'arbusto', height: 1, color: '#5f8f47', article: 'o' },
  { id: 'rock', label: 'pedra', surface: 0.6, height: 0.6, color: '#8d8a84', article: 'a' },
  { id: 'fence', size: '3×1', label: 'cerca', merge: true, height: 1, color: '#8b6040', article: 'a' },
  { id: 'street_lamp', label: 'poste de luz', height: 4, color: '#3b4148', article: 'o' },
  { id: 'trash_can', label: 'lixeira', height: 0.9, color: '#4f6d5a', article: 'a' },
  { id: 'fountain', size: '3×3', label: 'chafariz', merge: true, height: 1.2, color: '#c9c3b6', article: 'o' },
  { id: 'car', size: '2×4', label: 'carro', merge: true, facing: 'lengthwise', surface: 1.4, height: 1.4, color: '#9c3b3b', article: 'o' },
  { id: 'tent', size: '2×2', label: 'barraca', merge: true, facing: 'open_side', height: 1.6, color: '#6b7f4a', article: 'a' },
  { id: 'campfire', label: 'fogueira', height: 0.5, color: '#c46a2a', article: 'a' },
];

export const OBJECT_LIBRARY: Record<string, ObjectType> = Object.fromEntries(LIBRARY.map((t) => [t.id, t]));

/** O tipo pelo id: da biblioteca ou criado pelo mestre nesta campanha. Sem nenhum, uma caixa genérica. */
export function objectType(world: Pick<WorldState, 'objectTypes'> | null, kind: string): ObjectType {
  return OBJECT_LIBRARY[kind] ?? world?.objectTypes?.[kind] ?? { id: kind, label: kind.replace(/_/g, ' ') };
}

/** O tipo e os parecidos dele (like), do mais específico ao da biblioteca: de onde vêm visual e medidas. */
export function typeChain(world: Pick<WorldState, 'objectTypes'> | null, kind: string): ObjectType[] {
  const chain = [objectType(world, kind)];
  while (chain.length < 6) {
    const like = chain[chain.length - 1].like;
    if (!like || chain.some((t) => t.id === like)) break;
    chain.push(objectType(world, like));
  }
  return chain;
}

/** Acha um tipo pelo id ou pelo nome ("vitrine", "Vitrine", "display_case"). */
export function findObjectType(world: Pick<WorldState, 'objectTypes'> | null, ref: string): ObjectType | null {
  const all = [...LIBRARY, ...Object.values(world?.objectTypes ?? {})];
  const f = fold(ref.trim());
  return all.find((t) => t.id === ref || fold(t.id) === f || fold(t.label) === f || slugify(t.label) === slugify(ref)) ?? null;
}

/** A biblioteca resumida para o mestre: id e nome de cada tipo sem caractere fixo. */
export function librarySummary(): string {
  return LIBRARY.filter((t) => !t.char)
    .map((t) => `${t.id} (${[t.label, t.size, t.wall && 'na parede', t.seat && 'assento', t.exit && 'saída'].filter(Boolean).join(', ')})`)
    .join(', ');
}

/** Tipo pronto para usar: o que o mestre informou, completado pelo parecido (like). */
export function resolveType(base: ObjectType | null, own: Partial<ObjectType> & { label: string }): ObjectType {
  const { id: _id, char: _char, slug: _slug, label: _label, ...inherited } = base ?? { id: '', label: '' };
  const clean = Object.fromEntries(Object.entries(own).filter(([, v]) => v !== undefined)) as Partial<ObjectType>;
  return { ...inherited, ...clean, id: slugify(own.label), label: own.label, ...(base ? { like: base.id } : {}) };
}
