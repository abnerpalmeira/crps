import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Character, Figure, Fixture } from '../engine/types';

/**
 * Modelos 3D comprados (Synty), convertidos por `npm run assets` para public/models, fora do git.
 * Sem o catálogo (outra máquina, assets não convertidos), o palco segue com as primitivas.
 */
interface Catalog {
  /** Variantes de cor da textura-paleta de cada pacote (móveis usam a primeira). */
  textures: Record<string, string[]>;
  props: Record<string, { file: string; pack: string; size: [width: number, height: number, depth: number] }>;
  /** Peças de cada tipo de móvel do motor: posição em metros no espaço do móvel (frente = +z), yaw em graus. */
  fixtures: Record<string, { model: string; x?: number; y?: number; z?: number; yaw?: number; scale?: number }[]>;
  characters: Record<string, { file: string; pack: string; figure: Figure }>;
  /** Clipes por sexo, já no esqueleto dos personagens: idle, walk, talk, nod, sit. */
  anims: Record<'masc' | 'femn', { file: string; clips: string[] }>;
}

export type Clip = 'idle' | 'walk' | 'talk' | 'nod' | 'sit';

/** Personagem animado: o cenário troca o clipe conforme o estado do ator. */
export interface CharacterModel {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  actions: Partial<Record<Clip, THREE.AnimationAction>>;
}

const BASE = '/models/';
const loader = new GLTFLoader();
let catalog: Promise<Catalog | null> | null = null;
const sources = new Map<string, Promise<THREE.Object3D>>();
const clipSets = new Map<string, Promise<THREE.AnimationClip[]>>();
const atlases = new Map<string, THREE.Material>();

function loadCatalog(): Promise<Catalog | null> {
  catalog ??= fetch(`${BASE}catalog.json`)
    .then((res) => (res.ok ? (res.json() as Promise<Catalog>) : null))
    .catch(() => null);
  return catalog;
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

function source(file: string): Promise<THREE.Object3D> {
  let promise = sources.get(file);
  if (!promise) {
    promise = loader.loadAsync(BASE + file).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      return gltf.scene;
    });
    sources.set(file, promise);
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
 * gira). Peça maior que o espaço do móvel encolhe por inteiro para caber. null = sem modelo.
 */
export async function fixtureModel(f: Fixture): Promise<{ group: THREE.Group; top: number } | null> {
  const cat = await loadCatalog();
  const parts = cat?.fixtures[f.kind];
  if (!cat || !parts) return null;
  const alongX = f.facing === 'N' || f.facing === 'S';
  const room = { w: alongX ? f.w : f.h, d: alongX ? f.h : f.w };
  const group = new THREE.Group();
  let top = 0;
  for (const part of parts) {
    const entry = cat.props[part.model];
    const obj = (await source(entry.file)).clone();
    paint(obj, atlas(cat, entry.pack));
    const grow = part.scale ?? 1;
    const [mw, , md] = entry.size.map((v) => v * grow);
    const turned = Math.round((part.yaw ?? 0) / 90) % 2 !== 0;
    const scale = grow * Math.min(1, (room.w * 0.98) / (turned ? md : mw), (room.d * 0.98) / (turned ? mw : md));
    obj.scale.setScalar(scale);
    obj.position.set(part.x ?? 0, part.y ?? 0, part.z ?? 0);
    obj.rotation.y = THREE.MathUtils.degToRad(part.yaw ?? 0);
    group.add(obj);
    // A primeira peça é a principal (a mesa da carteira): é nela que os itens ficam apoiados.
    if (part === parts[0]) top = (part.y ?? 0) + entry.size[1] * scale;
  }
  return { group, top };
}

/** Corpo do personagem: o que o mestre informou ou, sem isso, o que o papel sugere. */
export function figureOf(c: Character): Figure {
  if (c.figure) return c.figure;
  const role = c.role.toLowerCase();
  const young = /alun|estudante|crian|menin|garot|filh|colegial|student|kid/.test(role);
  const femn = /\b(aluna|professora|diretora|menina|garota|filha|m[ãa]e|senhora|esposa|enfermeira|m[ée]dica|secret[áa]ria|cozinheira|dona)\b/.test(role)
    ? true
    : /\b(aluno|professor|diretor|menino|garoto|filho|pai|senhor|marido|enfermeiro|m[ée]dico|cozinheiro|dono)\b/.test(role)
      ? false
      : hash(c.id) % 2 === 1;
  return young ? (femn ? 'menina' : 'menino') : femn ? 'adulta' : 'adulto';
}

/** Personagem com modelo e clipes do catálogo, escolhido de forma estável pelo id; null = sem modelo. */
export async function characterModel(c: Character): Promise<CharacterModel | null> {
  const cat = await loadCatalog();
  if (!cat?.characters) return null;
  const figure = figureOf(c);
  const options = Object.values(cat.characters).filter((m) => m.figure === figure);
  if (!options.length) return null;
  const h = hash(c.id);
  const entry = options[h % options.length];
  const sex = figure === 'adulta' || figure === 'menina' ? 'femn' : 'masc';
  const [model, clips] = await Promise.all([source(entry.file), animations(cat, sex)]);
  const root = cloneSkinned(model);
  paint(root, atlas(cat, entry.pack, h >>> 8));
  // Adolescentes usam o mesmo esqueleto dos adultos: encolhem um pouco.
  if (figure === 'menino' || figure === 'menina') root.scale.setScalar(0.92);
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
