import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Character, Figure, Fixture, ObjectType } from '../engine/types';

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
  /** Clipes por sexo, já no esqueleto dos personagens: idle, walk, talk, nod, sit. */
  anims: Record<'masc' | 'femn', { file: string; clips: string[] }>;
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

export type Clip = 'idle' | 'walk' | 'talk' | 'nod' | 'sit';

/** Personagem animado: o cenário troca o clipe conforme o estado do ator. */
export interface CharacterModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Clip, THREE.AnimationAction>>;
}

/** Modelo do catálogo convertido pelo servidor: GLB só com a geometria e a textura de cada material. */
interface ModelMeta {
  file: string;
  kind: 'prop' | 'character';
  /** Largura, altura e profundidade em metros. */
  size: [number, number, number];
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
const clipSets = new Map<string, Promise<THREE.AnimationClip[]>>();
const atlases = new Map<string, THREE.Material>();
const metas = new Map<string, Promise<ModelMeta | null>>();
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

/** A ficha do modelo do catálogo; a primeira vez o servidor converte, o que leva alguns segundos. */
function modelMeta(id: string): Promise<ModelMeta | null> {
  let promise = metas.get(id);
  if (!promise) {
    promise = fetch(`/api/models/meta?id=${encodeURIComponent(id)}`)
      .then((res) => (res.ok ? (res.json() as Promise<ModelMeta>) : null))
      .catch(() => null);
    metas.set(id, promise);
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
export async function fixtureModel(f: Fixture, chain: ObjectType[]): Promise<{ group: THREE.Group; top: number; span: number } | null> {
  const chosen = chain.find((t) => t.model)?.model;
  const picked = chosen ? await catalogFixture(f, chosen) : null;
  if (picked) return picked;
  const kinds = chain.length ? chain.map((t) => t.id) : [f.kind];
  const cat = await loadCatalog();
  const entry = cat ? kinds.map((k) => cat.fixtures[k]).find(Boolean) : undefined;
  if (!cat || !entry?.length) return null;
  const variants = (Array.isArray(entry[0]) ? entry : [entry]) as Part[][];
  const parts = variants[hash(f.id) % variants.length];
  const alongX = f.facing === 'N' || f.facing === 'S';
  const room = { w: alongX ? f.w : f.h, d: alongX ? f.h : f.w };
  const group = new THREE.Group();
  let top = 0;
  let span = room.w;
  for (const part of parts) {
    const entry = cat.props[part.model];
    const obj = (await source(BASE + entry.file)).clone();
    paint(obj, atlas(cat, entry.pack));
    const grow = part.scale ?? 1;
    const [mw, , md] = entry.size.map((v) => v * grow);
    const turned = Math.round((part.yaw ?? 0) / 90) % 2 !== 0;
    const scale = part.fit === false ? grow : grow * Math.min(1, (room.w * 0.98) / (turned ? md : mw), (room.d * 0.98) / (turned ? mw : md));
    obj.scale.setScalar(scale);
    const length = (turned ? entry.size[2] : entry.size[0]) * scale;
    const stretch = part.stretch && !turned ? Math.max(1, (room.w * 0.95) / length) : 1;
    obj.scale.x *= stretch;
    obj.position.set(part.x ?? 0, part.y ?? 0, part.z ?? 0);
    obj.rotation.y = THREE.MathUtils.degToRad(part.yaw ?? 0);
    group.add(obj);
    // A primeira peça é a principal (a mesa da carteira): é nela que os itens ficam apoiados.
    if (part === parts[0]) {
      top = (part.y ?? 0) + entry.size[1] * scale;
      span = length * stretch;
    }
  }
  return { group, top, span };
}

/**
 * Móvel com um modelo do catálogo escolhido pelo mestre. Encolhe para caber no espaço do móvel;
 * natureza e construção podem passar dele (copa de árvore, torre), até uns 12 m de altura. Bicho
 * bem menor que o espaço cresce até ocupá-lo: os pacotes "simple" vêm em miniatura (o cavalo tem
 * 43 cm).
 */
async function catalogFixture(f: Fixture, id: string): Promise<{ group: THREE.Group; top: number; span: number } | null> {
  const meta = await modelMeta(id);
  if (!meta || meta.kind !== 'prop') return null;
  const obj = (await source(FILES + meta.file)).clone();
  paintCatalog(obj, meta);
  const alongX = f.facing === 'N' || f.facing === 'S';
  const room = { w: alongX ? f.w : f.h, d: alongX ? f.h : f.w };
  // O lado comprido do modelo vai no lado comprido do espaço (o cavalo deitado num 2×1).
  const turned = room.w !== room.d && room.w > room.d !== meta.size[0] > meta.size[2];
  const [w, h, d] = turned ? [meta.size[2], meta.size[1], meta.size[0]] : meta.size;
  const free = meta.category === 'ambiente' || meta.category === 'construcao';
  const fill = Math.min((room.w * 0.98) / w, (room.d * 0.98) / d);
  const scale = free ? Math.min(1, 12 / h) : meta.category === 'animal' && fill > 1.5 ? fill : Math.min(1, fill);
  obj.scale.setScalar(scale);
  if (turned) obj.rotation.y = Math.PI / 2;
  const group = new THREE.Group();
  group.add(obj);
  return { group, top: h * scale, span: w * scale };
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
  const [model, clips] = await Promise.all([source(BASE + entry.file), animations(cat, sex)]);
  const root = cloneSkinned(model);
  // Sempre a variante de cor principal: é a que as descrições dos visuais retratam.
  paint(root, atlas(cat, entry.pack));
  // Adolescentes usam o mesmo esqueleto dos adultos: encolhem um pouco.
  if (figure === 'menino' || figure === 'menina') root.scale.setScalar(0.92);
  const mixer = new THREE.AnimationMixer(root);
  const actions: CharacterModel['actions'] = {};
  for (const clip of clips) actions[clip.name as Clip] = mixer.clipAction(clip);
  return { root, mixer, actions };
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
  const cat = await loadCatalog();
  const [model, clips] = await Promise.all([source(FILES + meta.file), cat ? animations(cat, sex) : Promise.resolve([])]);
  const root = cloneSkinned(model);
  paintCatalog(root, meta);
  const head = meta.head ?? 1.6;
  if (head < 0.5 || head > 3) root.scale.setScalar(1.6 / head);
  const mixer = new THREE.AnimationMixer(root);
  const actions: CharacterModel['actions'] = {};
  for (const clip of clips) actions[clip.name as Clip] = mixer.clipAction(clip);
  return { root, mixer, actions };
}

function animations(cat: Catalog, sex: 'masc' | 'femn'): Promise<THREE.AnimationClip[]> {
  const set = cat.anims?.[sex];
  if (!set) return Promise.resolve([]);
  let promise = clipSets.get(sex);
  if (!promise) {
    promise = loader.loadAsync(BASE + set.file).then((gltf) => gltf.animations);
    clipSets.set(sex, promise);
  }
  return promise;
}
