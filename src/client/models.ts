import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Character, Figure, Fixture, Grip, Item, ObjectType } from '../engine/types';
import type { Rect } from './arrange';

/**
 * Modelos 3D comprados (Synty), convertidos por `npm run assets` para public/models, fora do git,
 * e os do catálogo inteiro, que o servidor converte na primeira vez que o 3D pede
 * (src/server/models.ts). Sem eles (outra máquina, assets não convertidos), o palco segue com as
 * primitivas.
 */
interface Catalog {
  /** Variantes de cor da textura-paleta de cada pacote (móveis usam a primeira). */
  textures: Record<string, string[]>;
  props: Record<string, { file: string; pack: string; size: [width: number, height: number, depth: number] }>;
  /**
   * Peças de cada tipo de objeto do motor: posição em metros no espaço do objeto (frente = +z),
   * yaw em graus. Uma lista de listas são variantes: cada objeto usa uma, escolhida pelo id.
   */
  fixtures: Record<string, Part[] | Part[][]>;
  characters: Record<string, { file: string; pack: string; figure: Figure; look: string }>;
  /** Onde fica o quadril de quem senta em cada tipo de assento, para a frente do centro (metros). */
  seats?: Record<string, number>;
  /** Clipes por sexo, já no esqueleto dos personagens, um arquivo por clipe em `dir`. */
  anims: Record<'masc' | 'femn', { dir: string; clips: string[] }>;
}

interface Part {
  model: string;
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  scale?: number;
  stretch?: boolean;
  /** false: a peça pode passar do tile (copa de árvore, poste); sem isso, encolhe para caber. */
  fit?: boolean;
}

/** Nome de um clipe de animação (idle, walk, acena, pistola_mira…: scripts/assets/synty.json). */
export type Clip = string;

/** Os clipes que todo personagem usa logo de cara; os outros carregam quando a cena pede. */
const BASE_CLIPS: Clip[] = ['idle', 'walk', 'talk', 'nod', 'sit'];

/** Ossos da mão de que o 3D precisa para pôr um item nela: o pulso e as juntas do indicador e do médio. */
export interface HandBones {
  wrist: THREE.Object3D;
  index: THREE.Object3D;
  finger: THREE.Object3D;
}

/** Personagem animado: o cenário troca o clipe conforme o estado do ator. */
export interface CharacterModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  sex: 'masc' | 'femn';
  /** Clipes já carregados; os outros vêm com `loadAction`. */
  actions: Map<Clip, THREE.AnimationAction>;
  hands: Partial<Record<'direita' | 'esquerda', HandBones>>;
  /** Osso da cabeça: o nome de quem está no chão vai com ela, não com o lugar onde estava de pé. */
  head?: THREE.Object3D;
}

/** Modelo do catálogo convertido pelo servidor: GLB só com a geometria e a textura de cada material. */
interface ModelMeta {
  file: string;
  kind: 'prop' | 'character' | 'held';
  /** Largura, altura e profundidade em metros. */
  size: [number, number, number];
  /** Na mão: a caixa do modelo em volta da origem (o punho). */
  bbox?: [[number, number, number], [number, number, number]];
  /** Altura da cabeça dos personagens (m). */
  head?: number;
  /** Pelo nome do material no GLB (tex_<chave>): a textura, se é recorte e o tom das folhas cinzentas. */
  materials: Record<string, ModelMaterial>;
  category: string;
  figure?: string;
}

interface ModelMaterial {
  texture: string | null;
  cutout?: boolean;
  tint?: [number, number, number];
}

const BASE = '/models/';
const FILES = '/api/models/file/';
const loader = new GLTFLoader();
let catalog: Promise<Catalog | null> | null = null;
let loaded: Catalog | null = null;
const sources = new Map<string, Promise<THREE.Object3D>>();
const clipFiles = new Map<string, Promise<THREE.AnimationClip | null>>();
const atlases = new Map<string, THREE.Material>();
const metas = new Map<string, Promise<ModelMeta | null>>();
const guesses = new Map<string, Promise<string | null>>();

/**
 * O modelo de um item: o que o mestre (ou o motor) escolheu; sem nenhum, o servidor dá o mais
 * parecido pelo nome e pela descrição (itens de campanhas antigas), só para o visual.
 */
function itemModelId(item: Item): Promise<string | null> {
  if (item.model) return Promise.resolve(item.model);
  const key = `${item.name}|${item.description}`;
  let promise = guesses.get(key);
  if (!promise) {
    promise = fetch(`/api/models/guess?name=${encodeURIComponent(item.name)}&desc=${encodeURIComponent(item.description)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ id: string }>) : null))
      .then((r) => r?.id ?? null)
      .catch(() => null);
    guesses.set(key, promise);
  }
  return promise;
}
const textured = new Map<string, THREE.Material>();

function loadCatalog(): Promise<Catalog | null> {
  catalog ??= fetch(`${BASE}catalog.json`)
    .then((res) => (res.ok ? (res.json() as Promise<Catalog>) : null))
    .then((cat) => (loaded = cat))
    .catch(() => null);
  return catalog;
}

/** Recuo de quem senta num assento com modelo; null antes do catálogo carregar ou sem dado para o tipo. */
export function seatOffset(kind: Fixture['kind']): number | null {
  return loaded?.seats?.[kind] ?? null;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Uma textura-paleta por pacote e variante, compartilhada por todos os modelos que a usam. */
function atlas(cat: Catalog, pack: string, variant = 0): THREE.Material {
  const variants = cat.textures[pack];
  const url = variants[variant % variants.length];
  let material = atlases.get(url);
  if (!material) {
    const map = new THREE.TextureLoader().load(BASE + url);
    map.colorSpace = THREE.SRGBColorSpace;
    map.flipY = false;
    material = new THREE.MeshStandardMaterial({ map, roughness: 0.85 });
    atlases.set(url, material);
  }
  return material;
}

/**
 * A ficha do modelo do catálogo; a primeira vez o servidor converte, o que leva alguns segundos.
 * `held` pede a versão que vai na mão, com a origem no punho.
 */
function modelMeta(id: string, held = false): Promise<ModelMeta | null> {
  const key = `${id}${held ? '|mao' : ''}`;
  let promise = metas.get(key);
  if (!promise) {
    promise = fetch(`/api/models/meta?id=${encodeURIComponent(id)}${held ? '&as=held' : ''}`)
      .then((res) => (res.ok ? (res.json() as Promise<ModelMeta>) : null))
      .catch(() => null);
    metas.set(key, promise);
  }
  return promise;
}

/** Material de uma textura do catálogo, compartilhado por todos os modelos que a usam. */
function catalogMaterial(m: ModelMaterial | undefined): THREE.Material {
  const key = m ? `${m.texture}|${m.cutout ? 1 : 0}|${m.tint?.join(',') ?? ''}` : 'liso';
  let material = textured.get(key);
  if (!material) {
    const map = m?.texture ? new THREE.TextureLoader().load(FILES + m.texture) : null;
    if (map) {
      map.colorSpace = THREE.SRGBColorSpace;
      map.flipY = false;
    }
    material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.85,
      // Sem textura (vidro, cor chapada), um cinza claro, como nas miniaturas do catálogo.
      color: m?.tint ? new THREE.Color(...m.tint) : map ? 0xffffff : 0x9a9ea8,
      ...(m?.cutout ? { alphaTest: 0.5, side: THREE.DoubleSide } : {}),
    });
    textured.set(key, material);
  }
  return material;
}

function paintCatalog(root: THREE.Object3D, meta: ModelMeta): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = catalogMaterial(meta.materials[(o.material as THREE.Material).name]);
  });
}

function source(url: string): Promise<THREE.Object3D> {
  let promise = sources.get(url);
  if (!promise) {
    promise = loader.loadAsync(url).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      return gltf.scene;
    });
    sources.set(url, promise);
  }
  return promise;
}

function paint(root: THREE.Object3D, material: THREE.Material): void {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) o.material = material;
  });
}

/**
 * O móvel montado com os modelos do catálogo, no espaço local do móvel (o chamador posiciona e
 * gira). `chain` é o tipo e os parecidos dele: vale o modelo que o mestre escolheu para algum deles
 * ou, sem isso, as peças do primeiro que tem. Peça maior que o espaço do móvel encolhe por inteiro
 * para caber; com stretch, a peça mais curta estica no comprimento. `span` é o comprimento da peça
 * principal. null = sem modelo.
 */
/**
 * O espaço em que o modelo de um móvel cabe, no espaço dele (largura × profundidade, frente = +z).
 * Objeto comprido (cama, carro) que um layout antigo desenhou menor que o tamanho típico ocupa o
 * tamanho típico, crescendo para a frente, que é a ponta livre (o pé da cama), em vez de virar
 * miniatura; `shift` é quanto o centro dele anda para a frente.
 */
export function footprint(f: Fixture, chain: ObjectType[]): { w: number; d: number; shift: number } {
  const alongX = f.facing === 'N' || f.facing === 'S';
  const w = alongX ? f.w : f.h;
  const d = alongX ? f.h : f.w;
  const size = chain.find((t) => t.size)?.size;
  const m = chain.some((t) => t.facing === 'lengthwise') ? /^(\d+)\s*[×x]\s*(\d+)$/.exec(size ?? '') : null;
  if (!m) return { w, d, shift: 0 };
  const [short, long] = [Number(m[1]), Number(m[2])].sort((a, b) => a - b);
  const full = Math.max(d, long);
  return { w: Math.max(w, short), d: full, shift: (full - d) / 2 };
}

/** Um móvel montado, com o que a cena precisa saber dele para pôr gente e coisas em cima. */
export interface FixtureModel {
  group: THREE.Group;
  /** Altura do tampo (ou do assento). */
  top: number;
  /** Comprimento do assento, de lado. */
  span: number;
  /** O tampo da peça principal no chão, no espaço do móvel (frente = +z): onde os itens se apoiam. */
  area: Rect;
}

export async function fixtureModel(f: Fixture, chain: ObjectType[]): Promise<FixtureModel | null> {
  const chosen = chain.find((t) => t.model)?.model;
  const picked = chosen ? await catalogFixture(f, chain, chosen) : null;
  if (picked) return picked;
  const kinds = chain.length ? chain.map((t) => t.id) : [f.kind];
  const cat = await loadCatalog();
  const entry = cat ? kinds.map((k) => cat.fixtures[k]).find(Boolean) : undefined;
  if (!cat || !entry?.length) return null;
  const variants = (Array.isArray(entry[0]) ? entry : [entry]) as Part[][];
  const parts = variants[hash(f.id) % variants.length];
  const room = footprint(f, chain);
  const lengthwise = chain.some((t) => t.facing === 'lengthwise');
  const group = new THREE.Group();
  group.position.z = room.shift;
  let top = 0;
  let span = room.w;
  let area: Rect = { x0: -room.w / 2, z0: room.shift - room.d / 2, x1: room.w / 2, z1: room.shift + room.d / 2 };
  for (const part of parts) {
    const entry = cat.props[part.model];
    const obj = (await source(BASE + entry.file)).clone();
    paint(obj, atlas(cat, entry.pack));
    const grow = part.scale ?? 1;
    const [mw, , md] = entry.size.map((v) => v * grow);
    const turned = Math.round((part.yaw ?? 0) / 90) % 2 !== 0;
    const scale = part.fit === false ? grow : grow * Math.min(1, (room.w * 0.98) / (turned ? md : mw), (room.d * 0.98) / (turned ? mw : md));
    obj.scale.setScalar(scale);
    // De lado e de frente no espaço do móvel (a peça virada troca os dois).
    const across = (turned ? entry.size[2] : entry.size[0]) * scale;
    const along = (turned ? entry.size[0] : entry.size[2]) * scale;
    // Esticar vai no comprido do móvel: a largura do sofá, o comprimento da cama.
    const stretch = part.stretch ? Math.max(1, lengthwise ? (room.d * 0.95) / along : (room.w * 0.95) / across) : 1;
    if (lengthwise !== turned) obj.scale.z *= stretch;
    else obj.scale.x *= stretch;
    obj.position.set(part.x ?? 0, part.y ?? 0, part.z ?? 0);
    obj.rotation.y = THREE.MathUtils.degToRad(part.yaw ?? 0);
    group.add(obj);
    // A primeira peça é a principal (a mesa da carteira): é nela que os itens ficam apoiados.
    if (part === parts[0]) {
      top = (part.y ?? 0) + entry.size[1] * scale;
      const w = lengthwise ? across : across * stretch;
      const d = lengthwise ? along * stretch : along;
      span = w;
      const [x, z] = [part.x ?? 0, room.shift + (part.z ?? 0)];
      area = { x0: x - w / 2, z0: z - d / 2, x1: x + w / 2, z1: z + d / 2 };
    }
  }
  return { group, top, span, area };
}

/**
 * Móvel com um modelo do catálogo escolhido pelo mestre. Encolhe para caber no espaço do móvel;
 * natureza e construção podem passar dele (copa de árvore, torre), até uns 12 m de altura. Bicho
 * bem menor que o espaço cresce até ocupá-lo: os pacotes "simple" vêm em miniatura (o cavalo tem
 * 43 cm).
 */
async function catalogFixture(f: Fixture, chain: ObjectType[], id: string): Promise<FixtureModel | null> {
  const meta = await modelMeta(id);
  if (!meta || meta.kind !== 'prop') return null;
  const obj = (await source(FILES + meta.file)).clone();
  paintCatalog(obj, meta);
  const room = footprint(f, chain);
  // O lado comprido do modelo vai no lado comprido do espaço (o cavalo deitado num 2×1).
  const turned = room.w !== room.d && room.w > room.d !== meta.size[0] > meta.size[2];
  const [w, h, d] = turned ? [meta.size[2], meta.size[1], meta.size[0]] : meta.size;
  const free = meta.category === 'ambiente' || meta.category === 'construcao';
  const fill = Math.min((room.w * 0.98) / w, (room.d * 0.98) / d);
  const scale = free ? Math.min(1, 12 / h) : meta.category === 'animal' && fill > 1.5 ? fill : Math.min(1, fill);
  obj.scale.setScalar(scale);
  if (turned) obj.rotation.y = Math.PI / 2;
  const group = new THREE.Group();
  group.position.z = room.shift;
  group.add(obj);
  const [sw, sd] = [w * scale, d * scale];
  return { group, top: h * scale, span: sw, area: { x0: -sw / 2, z0: room.shift - sd / 2, x1: sw / 2, z1: room.shift + sd / 2 } };
}

const FEMN = /\b(aluna|professora|diretora|menina|garota|filha|m[ãa]e|senhora|esposa|enfermeira|m[ée]dica|secret[áa]ria|cozinheira|dona|mulher|moça|moca|jovem mulher|ela)\b/;
const MASC = /\b(aluno|professor|diretor|menino|garoto|filho|pai|senhor|marido|enfermeiro|m[ée]dico|cozinheiro|dono|homem|rapaz|moço|moco|ele)\b/;

/**
 * Corpo do personagem: o do visual escolhido, o que o mestre informou ou, sem isso, o que papel e
 * aparência sugerem ("aluna", "mulher de uns quarenta anos"). Só no empate o id decide.
 */
export function figureOf(c: Character): Figure {
  if (c.figure) return c.figure;
  const text = `${c.role} ${c.appearance}`.toLowerCase();
  const young = /alun|estudante|crian|menin|garot|filh|colegial|adolescente|student|kid/.test(text);
  const role = c.role.toLowerCase();
  const appearance = c.appearance.toLowerCase();
  const femn = FEMN.test(role) ? true : MASC.test(role) ? false : FEMN.test(appearance) ? true : MASC.test(appearance) ? false : hash(c.id) % 2 === 1;
  return young ? (femn ? 'menina' : 'menino') : femn ? 'adulta' : 'adulto';
}

/** Personagem com modelo e clipes do catálogo, escolhido de forma estável pelo id; null = sem modelo. */
export async function characterModel(c: Character): Promise<CharacterModel | null> {
  // Visual do catálogo inteiro (pacote:Arquivo); se não converter, segue como se não houvesse.
  const picked = c.look?.includes(':') ? await catalogCharacter(c, c.look) : null;
  if (picked) return picked;
  const cat = await loadCatalog();
  if (!cat?.characters) return null;
  // O visual escolhido pelo mestre (e descrito na aparência); sem ele, um do mesmo corpo, pelo id.
  const chosen = c.look ? cat.characters[c.look] : undefined;
  const figure = chosen?.figure ?? figureOf(c);
  const options = Object.values(cat.characters).filter((m) => m.figure === figure);
  if (!chosen && !options.length) return null;
  const entry = chosen ?? options[hash(c.id) % options.length];
  const sex = figure === 'adulta' || figure === 'menina' ? 'femn' : 'masc';
  const root = cloneSkinned(await source(BASE + entry.file));
  // Sempre a variante de cor principal: é a que as descrições dos visuais retratam.
  paint(root, atlas(cat, entry.pack));
  // Adolescentes usam o mesmo esqueleto dos adultos: encolhem um pouco.
  if (figure === 'menino' || figure === 'menina') root.scale.setScalar(0.92);
  return animated(root, sex);
}

/**
 * Personagem do catálogo inteiro, com os clipes do corpo dele. Os ossos já vêm com os nomes do
 * esqueleto das animações; criatura anima como adulto. Há pacotes em centímetros: pela altura da
 * cabeça, o modelo volta ao tamanho de gente.
 */
async function catalogCharacter(c: Character, id: string): Promise<CharacterModel | null> {
  const meta = await modelMeta(id);
  if (!meta || meta.kind !== 'character') return null;
  const figure = (['adulto', 'adulta', 'menino', 'menina'] as string[]).includes(meta.figure ?? '') ? (meta.figure as Figure) : figureOf(c);
  const sex = figure === 'adulta' || figure === 'menina' ? 'femn' : 'masc';
  const root = cloneSkinned(await source(FILES + meta.file));
  paintCatalog(root, meta);
  const head = meta.head ?? 1.6;
  if (head < 0.5 || head > 3) root.scale.setScalar(1.6 / head);
  return animated(root, sex);
}

/** O personagem com o mixer, os clipes de sempre já carregados e os ossos das mãos. */
async function animated(root: THREE.Object3D, sex: 'masc' | 'femn'): Promise<CharacterModel> {
  const model: CharacterModel = { root, mixer: new THREE.AnimationMixer(root), sex, actions: new Map(), hands: {}, head: root.getObjectByName('Head') };
  for (const [hand, wrist, index, finger] of [
    ['direita', 'Hand_R', 'IndexFinger_01_1', 'Finger_01_1'],
    ['esquerda', 'Hand_L', 'IndexFinger_01', 'Finger_01'],
  ] as const) {
    const bones = [wrist, index, finger].map((name) => root.getObjectByName(name));
    if (bones.every(Boolean)) model.hands[hand] = { wrist: bones[0]!, index: bones[1]!, finger: bones[2]! };
  }
  await Promise.all(BASE_CLIPS.map((clip) => loadAction(model, clip)));
  return model;
}

/** Um clipe de um sexo, carregado uma vez e compartilhado; null se não existe. */
function clipFile(sex: 'masc' | 'femn', name: Clip): Promise<THREE.AnimationClip | null> {
  const key = `${sex}/${name}`;
  let promise = clipFiles.get(key);
  if (!promise) {
    promise = loadCatalog().then((cat) => {
      const set = cat?.anims?.[sex];
      if (!set?.dir || !set.clips.includes(name)) return null;
      return loader
        .loadAsync(`${BASE}${set.dir}/${name}.glb`)
        .then((gltf) => {
          const clip = gltf.animations[0] ?? null;
          if (clip) clip.name = name;
          return clip;
        })
        .catch(() => null);
    });
    clipFiles.set(key, promise);
  }
  return promise;
}

/** A ação de um clipe no personagem, carregando o clipe na primeira vez; null se não existe. */
export async function loadAction(model: CharacterModel, name: Clip): Promise<THREE.AnimationAction | null> {
  const ready = model.actions.get(name);
  if (ready) return ready;
  const clip = await clipFile(model.sex, name);
  if (!clip) return null;
  const action = model.actions.get(name) ?? model.mixer.clipAction(clip);
  model.actions.set(name, action);
  return action;
}

/** Ossos do tronco para cima: um gesto feito sentado ou ajoelhado mexe só neles. */
const UPPER = /^(Spine_02|Spine_03|Neck|Head|Eyes|Eyebrows|Jaw|Clavicle|Shoulder|Elbow|Hand|Thumb|IndexFinger|Finger)/;
const upperClips = new Map<THREE.AnimationClip, THREE.AnimationClip>();

/** A ação de um clipe só no tronco e nos braços, para tocar por cima de uma pose sentada. */
export async function loadUpperAction(model: CharacterModel, name: Clip): Promise<THREE.AnimationAction | null> {
  const key = `${name}#tronco`;
  const ready = model.actions.get(key);
  if (ready) return ready;
  const clip = await clipFile(model.sex, name);
  if (!clip) return null;
  let upper = upperClips.get(clip);
  if (!upper) {
    upper = new THREE.AnimationClip(key, clip.duration, clip.tracks.filter((t) => UPPER.test(t.name.split('.')[0])));
    upperClips.set(clip, upper);
  }
  const action = model.mixer.clipAction(upper);
  model.actions.set(key, action);
  return action;
}

/** Um item no 3D: o objeto e, na mão, onde fica o cano ou a ponta (no espaço do objeto). */
export interface ItemModel {
  obj: THREE.Object3D;
  /** Ponta do cano (armas de fogo) ou da arma, para o clarão do tiro. */
  tip: THREE.Vector3;
  /**
   * Haste com o punho no meio (lança, cajado, tocha): o modelo dentro do objeto, quanto ele já
   * desliza para a mão ficar perto da ponta de baixo e onde fica essa ponta, ao longo de +y.
   */
  shaft?: { inner: THREE.Object3D; slide: number; low: number };
}

/** Primitiva de um item sem modelo, no jeito de empunhar: cano em +z, lâmina em +y, punho na origem. */
function heldPrimitive(grip: Grip): ItemModel {
  const dark = new THREE.MeshStandardMaterial({ color: '#2b2d33', roughness: 0.6, metalness: 0.3 });
  const wood = new THREE.MeshStandardMaterial({ color: '#6b4a2c', roughness: 0.8 });
  const [w, h, d, x, y, z, material] = {
    pistola: [0.04, 0.12, 0.22, 0, 0.02, 0.06, dark],
    arma_longa: [0.05, 0.12, 0.95, 0, 0.02, 0.2, dark],
    arco: [0.04, 1.3, 0.05, 0, 0, 0, wood],
    uma_mao: [0.03, 0.85, 0.08, 0, 0.32, 0, dark],
    duas_maos: [0.05, 1.9, 0.05, 0, 0.45, 0, wood],
    escudo: [0.6, 0.6, 0.06, 0, 0, 0.05, wood],
    objeto: [0.09, 0.12, 0.09, 0, 0, 0, dark],
  }[grip] as [number, number, number, number, number, number, THREE.Material];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  const obj = new THREE.Group();
  obj.add(mesh);
  return { obj, tip: new THREE.Vector3(x, y + (grip === 'uma_mao' || grip === 'duas_maos' ? h / 2 : 0), z + d / 2) };
}

/**
 * O item como vai na mão: o modelo do catálogo, com o punho na origem, o cano em +z e a lâmina em
 * +y (a convenção das armas da Synty); arma deitada de outro jeito no arquivo é girada para ela.
 * Objeto comum fica com o meio na mão. Sem modelo, uma primitiva do jeito de empunhar.
 */
export async function heldModel(item: Item, grip: Grip): Promise<ItemModel> {
  const id = await itemModelId(item);
  const meta = id ? await modelMeta(id, true) : null;
  if (!meta || meta.kind !== 'held' || !meta.bbox) return heldPrimitive(grip);
  const model = (await source(FILES + meta.file)).clone();
  paintCatalog(model, meta);
  const [lo, hi] = meta.bbox.map((v) => new THREE.Vector3(...v));
  const size = hi.clone().sub(lo);
  const long = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
  // Arma de fogo aponta em +z; o resto (lâmina, cabo, haste, arco) em +y. A ponta é o lado mais
  // longe do punho.
  const want = grip === 'pistola' || grip === 'arma_longa' ? 'z' : 'y';
  const holder = new THREE.Group();
  holder.add(model);
  if (grip === 'objeto' || grip === 'escudo') {
    const [thin, mid, wide] = (['x', 'y', 'z'] as const).slice().sort((a, b) => size[a] - size[b]);
    if (grip === 'escudo' || size[thin] >= 0.35 * size[mid]) {
      model.position.copy(lo.clone().add(hi).multiplyScalar(-0.5));
      return { obj: holder, tip: new THREE.Vector3(0, size.y / 2, 0) };
    }
    // Coisa chata (pasta, livro, papel, celular) vai com a face na palma, não atravessada nela: a
    // pequena deitada na palma, ao comprido dos dedos (+z); a grande pendurada pela borda comprida,
    // como quem carrega uma pasta do lado do corpo.
    const hang = size[wide] > 0.2;
    const to = { x: new THREE.Vector3(), y: new THREE.Vector3(), z: new THREE.Vector3() };
    to[thin].set(1, 0, 0);
    to[wide].set(0, hang ? 1 : 0, hang ? 0 : 1);
    to[mid].set(0, hang ? 0 : 1, hang ? 1 : 0);
    const turn = new THREE.Matrix4().makeBasis(to.x, to.y, to.z);
    if (turn.determinant() < 0) turn.makeBasis(to.x, to.y, to.z.negate());
    model.quaternion.setFromRotationMatrix(turn);
    const box = new THREE.Box3(lo.clone(), hi.clone()).applyMatrix4(turn);
    model.position.copy(box.getCenter(new THREE.Vector3()).negate());
    // Pendurada: a borda de cima fica entre os dedos, e o resto desce além deles.
    if (hang) model.position.z += (box.max.z - box.min.z) / 2 - 0.04;
    return { obj: holder, tip: new THREE.Vector3(0, 0, 0) };
  }
  if (long !== want) {
    const from = new THREE.Vector3(long === 'x' ? 1 : 0, long === 'y' ? 1 : 0, long === 'z' ? 1 : 0);
    if (Math.abs(lo[long]) > Math.abs(hi[long])) from.negate();
    const to = new THREE.Vector3(0, want === 'y' ? 1 : 0, want === 'z' ? 1 : 0);
    model.quaternion.setFromUnitVectors(from, to);
  }
  const box = new THREE.Box3().setFromObject(model);
  const tip = new THREE.Vector3(0, 0, 0);
  tip[want] = Math.abs(box.min[want]) > Math.abs(box.max[want]) ? box.min[want] : box.max[want];
  // Punho no meio do comprimento: a mão vai para perto da ponta de baixo, senão a haste atravessa o corpo.
  const length = box.max.y - box.min.y;
  if (want === 'y' && -box.min.y > 0.3 * length && box.max.y > 0.3 * length) {
    const slide = -(box.min.y + 0.15 * length);
    model.position.y += slide;
    tip.y += slide;
    return { obj: holder, tip, shaft: { inner: model, slide: model.position.y, low: box.min.y + slide } };
  }
  return { obj: holder, tip };
}

/**
 * O item no chão ou num móvel: o modelo do catálogo, que coisa comprida deita (espada, fuzil);
 * null sem modelo (o 3D segue com a primitiva).
 */
export async function groundModel(item: Item): Promise<THREE.Object3D | null> {
  const id = await itemModelId(item);
  const meta = id ? await modelMeta(id) : null;
  if (!meta || meta.kind !== 'prop') return null;
  const model = (await source(FILES + meta.file)).clone();
  paintCatalog(model, meta);
  const [w, h, d] = meta.size;
  const obj = new THREE.Group();
  obj.add(model);
  // Mais alto que comprido e fino: deita de lado, apoiado no chão.
  if (h > 1.8 * Math.max(w, d) && h > 0.25) {
    model.rotation.z = Math.PI / 2;
    model.position.set(h / 2, Math.max(w, d) / 2, 0);
  } else if (d < 0.2 * Math.min(w, h)) {
    // Folha em pé (bilhete, carta, placa): deita com a face para cima.
    model.rotation.x = -Math.PI / 2;
    model.position.set(0, d / 2, h / 2);
  } else if (w < 0.2 * Math.min(d, h)) {
    model.rotation.z = Math.PI / 2;
    model.position.set(h / 2, w / 2, 0);
  }
  // Coisa grande demais para um item (um erro do modelo) encolhe para caber num tile.
  const big = Math.max(w, h, d);
  if (big > 1.6) obj.scale.setScalar(1.6 / big);
  return obj;
}
