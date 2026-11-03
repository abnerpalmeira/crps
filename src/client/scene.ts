import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { GESTURES, GRIPS, POSES, bodyPose, clipFor, gripOf, handsOf, mainGrip, variantIndex, type Act, type Grip, type Hand } from '../engine/body';
import { ERA_DOORS, decorModel, locationLook } from '../engine/eras';
import { isPassable, tileDef } from '../engine/layout';
import { besideRect, findPath, walkGoal, type GridRect } from '../engine/path';
import { lightSources } from '../engine/light';
import { hasNews } from '../engine/lines';
import { typeChain } from '../engine/objects';
import { lifeStatId, perceptionOf, strangerLabel, visionOf } from '../engine/perception';
import type { Character, Fixture, Item, Location, ObjectType, Pos, WorldState } from '../engine/types';
import { arrange, type Rect, type Spot } from './arrange';
import { decorSpots, type DecorSpot } from './dressing';
import { capitalize } from './format';
import {
  catalogProp,
  characterModel,
  fixtureModel,
  footprint,
  groundModel,
  heldModel,
  loadAction,
  loadUpperAction,
  seatOffset,
  type CharacterModel,
  type Clip,
  type ItemModel,
} from './models';
import {
  DIR_VEC,
  YAW,
  buildCharacter,
  buildFixture,
  buildItem,
  drawBoard,
  floorColor,
  hash,
  mat,
  playerRing,
  setSeated,
  setWallLook,
  wallPiece,
} from './props';

/** Tamanho máximo (m) e altura na parede de cada decoração: o centro, ou o topo na tapeçaria, que pende. */
const DECOR_FIT: Record<string, { w: number; h: number; y: number; top?: boolean }> = {
  quadros: { w: 0.8, h: 0.7, y: 1.55 },
  tapecarias: { w: 0.7, h: 1.5, y: 2.25, top: true },
  luminarias: { w: 0.35, h: 0.7, y: 1.8 },
  armas: { w: 0.9, h: 0.9, y: 1.6 },
  prateleiras: { w: 0.9, h: 0.6, y: 1.45 },
  cartazes: { w: 0.55, h: 0.75, y: 1.5 },
};

/**
 * Um modelo chato (porta, quadro, estandarte) de pé no plano x-y, com a parte fina em z: o que vem
 * com o lado comprido em z gira um quarto. `keep` mantém as proporções (cabe em w × h); sem ele,
 * estica para preencher w × h (a folha da porta no vão).
 */
function fitted2D(model: THREE.Object3D, size: [number, number, number], w: number, h: number, keep: boolean): THREE.Group {
  const [mw, mh, md] = size;
  const turned = mw < md;
  const [across, thin] = turned ? [md, mw] : [mw, md];
  const inner = model.clone();
  if (turned) inner.rotation.y = Math.PI / 2;
  const holder = new THREE.Group();
  holder.add(inner);
  if (keep) holder.scale.setScalar(Math.min(w / across, h / mh, 1.6));
  else holder.scale.set(w / across, h / mh, Math.min(w / across, h / mh, 0.05 / Math.max(thin, 0.01)));
  return holder;
}

export interface Pick {
  kind: 'character' | 'fixture' | 'item';
  id: string;
}

/** O que está sob o mouse: uma pessoa, um móvel, um item ou um tile do chão. */
type Target = Pick | { kind: 'tile'; x: number; y: number };

interface Actor {
  obj: THREE.Group;
  label: CSS2DObject;
  target: THREE.Vector3;
  yaw: number;
  seated: boolean;
  /** O caminho que falta andar: o centro de cada tile e, no fim, o lugar exato (o assento). */
  route: THREE.Vector3[];
  /** Tiles por segundo no caminho atual, e para onde o corpo vira enquanto anda. */
  speed: number;
  walkYaw: number;
  /** Sentou do outro lado da sala: o corpo dobra quando chegar, não no caminho. */
  sitOnArrival?: boolean;
  /** Personagem animado do catálogo, quando já carregou (antes disso, o boneco primitivo). */
  model?: CharacterModel;
  /** Clipe pedido para o corpo inteiro (a pose, o andar ou um gesto) e a ação que está tocando. */
  clip?: Clip;
  current?: THREE.AnimationAction;
  /** Clipes que não existem nesta máquina: a pose cai para o parado. */
  missing: Set<Clip>;
  /** Pose do corpo (body.ts) e o clipe dela, conforme o que a pessoa empunha. */
  pose: string;
  poseClip: Clip;
  /** De pé; baixo (sentado, ajoelhado: gesto mexe só o tronco); no chão (deitado, caído: sem gestos). */
  stance: 'pe' | 'baixo' | 'chao';
  grip: Grip | null;
  /** Gesto em curso: até quando manda no corpo, e se toca só no tronco por cima da pose. */
  gesture?: { action: THREE.AnimationAction | null; start: number; until: number; upper: boolean; yaw: number | null };
  /** O que está em cada mão. */
  held: Map<Hand, Held>;
}

/** Um item na mão de alguém: segue os ossos da mão a cada quadro. */
interface Held {
  key: string;
  grip: Grip;
  model: ItemModel | null;
}

const TALK_POSES = new Set(['de_pe', 'sentado', 'bracos_cruzados', 'maos_na_cintura', 'pensativo', 'timido', 'abatido', 'bebado', 'encostado']);
const LOW_POSES = new Set(['sentado', 'ajoelhado', 'agachado']);
const FIREARMS = new Set<Grip>(['pistola', 'arma_longa']);
const V1 = new THREE.Vector3();
const V2 = new THREE.Vector3();
const V3 = new THREE.Vector3();
const BASIS = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** Quadrado de lado 2r em volta de um ponto do chão. */
function around(x: number, z: number, r: number): Rect {
  return { x0: x - r, z0: z - r, x1: x + r, z1: z + r };
}

interface WallPart {
  obj: THREE.Object3D;
  /** Normal para fora da sala, no plano XZ; a parede some quando fica entre a câmera e o interior. */
  normal: THREE.Vector2 | null;
}

const PLAYER_COLOR = '#f0b35a';
/** Destaque do que está sob o mouse, e do tile onde não dá para ficar ou aonde não há caminho. */
const HOVER_COLOR = '#9fd8ff';
const BLOCKED_COLOR = '#ff7a6b';
/** Pontos do caminho desenhado no chão: dois por tile. */
const TRAIL_MAX = 400;

/** Marca de um tile no chão: borda viva e miolo claro, na cor de cada uso (placeMark). */
function tileMark(): THREE.Group {
  const mark = new THREE.Group();
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(0.94, 0.94), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, depthWrite: false }));
  // Anel de quatro lados começando em 45°: um quadrado vazado, com as bordas no grid.
  const edge = new THREE.Mesh(
    new THREE.RingGeometry(0.4 * Math.SQRT2, 0.47 * Math.SQRT2, 4, 1, Math.PI / 4),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthWrite: false }),
  );
  for (const part of [fill, edge]) {
    part.rotation.x = -Math.PI / 2;
    mark.add(part);
  }
  mark.visible = false;
  return mark;
}

function placeMark(mark: THREE.Group, p: Pos, color: string, y: number): void {
  mark.position.set(p.x, y, p.y);
  for (const part of mark.children) ((part as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
  mark.visible = true;
}

const EXIT_ICON: Partial<Record<Fixture['kind'], string>> = { door: '🚪', elevator: '🛗', stairs: '🪜' };

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function tagPick(obj: THREE.Object3D, pick: Pick): void {
  obj.traverse((o) => (o.userData.pick = pick));
}

/** Altura do nome sobre a pessoa: de pé, sentada ou ajoelhada, deitada. */
function labelHeight(actor: Actor): number {
  return actor.stance === 'chao' ? 0.75 : actor.stance === 'baixo' ? 1.62 : 2.0;
}

/** O que muda o item na mão no 3D: outro item, outro modelo, outro jeito de empunhar. */
function heldKey(item: Item): string {
  return `${item.id}|${item.model ?? ''}|${gripOf(item)}`;
}

/**
 * Visão 3D do estado: uma função do mundo, que nunca guarda estado próprio
 * além de animações. O grid (x, y) vira o plano (x, z).
 */
export class WorldView {
  onPick: (pick: Pick | null) => void = () => {};
  /** Clique no chão: o jogador anda até o tile, sem o mestre. */
  onWalk: (x: number, y: number) => void = () => {};

  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300);
  private readonly controls: OrbitControls;
  private readonly sun = new THREE.DirectionalLight('#fff1dc', 2.4);
  private readonly sky = new THREE.HemisphereLight('#dfe8ff', '#6b5a48', 1.5);
  /** Luzes acesas (lanternas, velas, poderes), presas a quem carrega ou ao item. */
  private lamps = new Map<string, THREE.PointLight>();
  /** Véu sobre o palco quando a visão do jogador falha (cegueira, vista turva). */
  private readonly veil = document.createElement('div');
  private readonly raycaster = new THREE.Raycaster();
  private readonly clock = new THREE.Clock();
  private room = new THREE.Group();
  private walls: WallPart[] = [];
  /** Decoração pendurada, com a parede dela: some quando a parede abaixa para a câmera ver o cômodo. */
  private decor: { obj: THREE.Object3D; wall: THREE.Object3D }[] = [];
  private actors = new Map<string, Actor>();
  private items = new Map<string, THREE.Object3D>();
  private boards = new Map<string, { surface: THREE.Mesh; text: string; length: number }>();
  private balloons = new Map<string, CSS2DObject>();
  /** Placa de cada saída (porta, elevador, escada) com o nome que ela tem no motor; clicar abre o inspetor. */
  private signs = new Map<string, CSS2DObject>();
  private roomKey = '';
  /** Última fala que fez um personagem gesticular, para não repetir a cada passo do replay. */
  private lastTalk = '';
  /** Altura de apoio dos móveis que já trocaram a primitiva por modelo. */
  private surfaces = new Map<string, number>();
  /** Comprimento do modelo de cada móvel, que pode ser menor que os tiles dele (um sofá de 3 tiles). */
  private spans = new Map<string, number>();
  /** O tampo de cada móvel com modelo, no espaço dele: onde os itens se apoiam. */
  private areas = new Map<string, Rect>();
  /** Largura e profundidade do modelo de cada item no chão ou num móvel, quando já carregou. */
  private itemSizes = new Map<string, [number, number]>();
  private shown: { world: WorldState; loc: Location } | null = null;
  private selected: Pick | null = null;
  private selectionRing = playerRing('#ffffff');
  private selectionBox: THREE.BoxHelper | null = null;
  /** O que está sob o mouse, destacado, com o caminho do jogador até lá desenhado no chão. */
  private hovered: Target | null = null;
  private readonly hoverMark = tileMark();
  private readonly goalMark = tileMark();
  private readonly hoverRing = playerRing(HOVER_COLOR);
  private hoverBox: THREE.BoxHelper | null = null;
  private readonly trail = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.07, 12).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: PLAYER_COLOR, transparent: true, opacity: 0.9, depthWrite: false }),
    TRAIL_MAX,
  );
  private pressed = { x: 0, y: 0 };

  constructor(private readonly host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    this.veil.className = 'vision-veil';
    host.appendChild(this.veil);
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.32;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 70;
    this.controls.screenSpacePanning = false;

    this.scene.add(this.sky);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    const ground = new THREE.Mesh(new THREE.CircleGeometry(120, 48), mat('#2a2f3b'));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.11;
    ground.receiveShadow = true;
    this.scene.add(ground);
    this.selectionRing.visible = false;
    this.scene.add(this.selectionRing);
    this.hoverRing.visible = false;
    this.trail.count = 0;
    // As matrizes dos pontos mudam a cada alvo: a esfera de recorte da geometria não vale para eles.
    this.trail.frustumCulled = false;
    this.scene.add(this.hoverRing, this.hoverMark, this.goalMark, this.trail);

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => (this.pressed = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.pressed.x, e.clientY - this.pressed.y) > 5) return;
      const pick = this.pickAt(e);
      if (pick?.kind === 'tile') return this.onWalk(pick.x, pick.y);
      this.select(pick);
    });
    canvas.addEventListener('pointermove', (e) => {
      const pick = this.pickAt(e);
      canvas.style.cursor = !pick ? 'grab' : pick.kind === 'tile' ? 'cell' : 'pointer';
      // Arrastando, a câmera gira: o destaque e o caminho voltam depois de soltar.
      this.hover(e.buttons ? null : pick);
    });
    canvas.addEventListener('pointerleave', () => this.hover(null));
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setWorld(world: WorldState): void {
    const player = world.playerId ? world.characters[world.playerId] : null;
    const locId = player?.locationId ?? Object.keys(world.locations).at(-1);
    const loc = locId ? world.locations[locId] : null;
    const key = loc ? `${world.id}:${loc.id}:${loc.tiles.join('|')}` : '';
    if (key !== this.roomKey) {
      this.buildRoom(world, loc);
      this.roomKey = key;
    }
    if (!loc) return;
    this.shown = { world, loc };
    this.syncBoards(loc);
    this.syncSigns(loc);
    this.syncActors(world, loc);
    this.syncItems(world, loc);
    this.syncLight(world, loc);
    if (this.selected && !this.exists(this.selected)) this.select(null);
    // O jogador e quem está no caminho podem ter mudado de lugar: o caminho sob o mouse se refaz.
    this.drawHover();
  }

  clear(): void {
    this.select(null);
    this.hovered = null;
    this.drawHover();
    this.buildRoom(null, null);
    this.roomKey = '';
  }

  /**
   * Balões de fala sobre os personagens: um por personagem (a fala mais recente dele).
   * `age` 0 é a fala atual; 1 e 2 vão esmaecendo. Devolve os ids que não estão em cena.
   */
  setBalloons(lines: { speakerId: string; html: string; age: number; mode?: string }[]): string[] {
    const wanted = new Map(lines.map((l) => [l.speakerId, l]));
    for (const id of [...this.balloons.keys()]) if (!wanted.has(id)) this.removeBalloon(id);
    const missing: string[] = [];
    for (const [id, line] of wanted) {
      const actor = this.actors.get(id);
      if (!actor) {
        missing.push(id);
        continue;
      }
      let balloon = this.balloons.get(id);
      if (!balloon) {
        const anchor = document.createElement('div');
        anchor.className = 'balloon-anchor';
        anchor.append(document.createElement('div'));
        anchor.firstElementChild!.className = 'balloon';
        balloon = new CSS2DObject(anchor);
        actor.obj.add(balloon);
        this.balloons.set(id, balloon);
      }
      const age = Math.min(line.age, 2);
      balloon.element.firstElementChild!.innerHTML = line.html;
      if (line.age === 0 && this.lastTalk !== `${id}:${line.html}`) {
        this.lastTalk = `${id}:${line.html}`;
        // Quem fala gesticula, se a pose deixa (mirando com a arma, não).
        if (TALK_POSES.has(actor.pose) && !actor.gesture) void this.gesture(actor, 'talk', null);
      }
      balloon.element.dataset.age = String(age);
      balloon.element.dataset.mode = line.mode ?? 'fala';
      // Falas mais antigas sobem: vizinhos que falam em sequência não se sobrepõem.
      balloon.position.set(0, labelHeight(actor) + 0.24 + age * 0.5, 0);
    }
    return missing;
  }

  private removeBalloon(id: string): void {
    const balloon = this.balloons.get(id);
    if (!balloon) return;
    balloon.element.remove();
    balloon.parent?.remove(balloon);
    this.balloons.delete(id);
  }

  select(pick: Pick | null): void {
    this.selected = pick;
    this.selectionRing.visible = pick?.kind === 'character' && this.actors.has(pick.id);
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.dispose();
      this.selectionBox = null;
    }
    if (pick && pick.kind !== 'character') {
      const target = pick.kind === 'item' ? this.items.get(pick.id) : this.room.getObjectByProperty('name', `fixture:${pick.id}`);
      if (target) {
        this.selectionBox = new THREE.BoxHelper(target, '#ffffff');
        this.scene.add(this.selectionBox);
      }
    }
    for (const [id, a] of this.actors) a.label.element.classList.toggle('selected', pick?.kind === 'character' && pick.id === id);
    for (const [id, s] of this.signs) s.element.classList.toggle('selected', pick?.kind === 'fixture' && pick.id === id);
    this.onPick(pick);
  }

  private exists(pick: Pick): boolean {
    if (pick.kind === 'character') return this.actors.has(pick.id);
    if (pick.kind === 'item') return this.items.has(pick.id);
    return Boolean(this.room.getObjectByProperty('name', `fixture:${pick.id}`));
  }

  /** O alvo sob o mouse; o destaque e o caminho só se refazem quando ele muda. */
  private hover(target: Target | null): void {
    const key = (t: Target | null) => (!t ? '' : t.kind === 'tile' ? `tile:${t.x},${t.y}` : `${t.kind}:${t.id}`);
    if (key(target) === key(this.hovered)) return;
    this.hovered = target;
    this.drawHover();
  }

  /**
   * Destaca o alvo sob o mouse (o tile, o anel de quem está ali, a caixa do móvel ou do item) e desenha
   * o caminho do jogador até onde ele pararia, pelas regras do motor no clique e em "Ir até". O tile
   * onde não dá para ficar, ou aonde não há caminho, fica vermelho, e a marca laranja diz onde o
   * jogador para de fato.
   */
  private drawHover(): void {
    this.hoverMark.visible = this.goalMark.visible = this.hoverRing.visible = false;
    this.trail.count = 0;
    if (this.hoverBox) {
      this.scene.remove(this.hoverBox);
      this.hoverBox.dispose();
      this.hoverBox = null;
    }
    const t = this.hovered;
    if (!t || !this.shown) return;
    const { world, loc } = this.shown;
    const at = new Map(Object.values(world.characters).flatMap((c) => (c.locationId === loc.id && c.pos ? [[`${c.pos.x},${c.pos.y}`, c.id] as const] : [])));
    const occupant = (x: number, y: number) => at.get(`${x},${y}`) ?? null;
    const me = world.playerId ? world.characters[world.playerId] : undefined;
    const from = me?.locationId === loc.id ? me.pos : null;
    const goal = me && from ? this.goalOf(world, loc, me, from, t, occupant) : null;
    const path = me && from && goal ? findPath(loc, from, goal, (x, y) => ![null, me.id].includes(occupant(x, y))) : null;
    const walks = path !== null && path.length > 1;
    if (t.kind === 'tile') {
      const here = from?.x === t.x && from.y === t.y;
      const reached = walks && goal!.x === t.x && goal!.y === t.y;
      placeMark(this.hoverMark, t, reached ? PLAYER_COLOR : here || !from ? HOVER_COLOR : BLOCKED_COLOR, 0.008);
    } else if (t.kind === 'character') {
      this.hoverRing.visible = this.actors.has(t.id);
    } else {
      const obj = t.kind === 'item' ? this.items.get(t.id) : this.room.getObjectByProperty('name', `fixture:${t.id}`);
      if (obj) {
        this.hoverBox = new THREE.BoxHelper(obj, HOVER_COLOR);
        this.scene.add(this.hoverBox);
      }
    }
    if (!walks) return;
    const end = path[path.length - 1];
    if (t.kind !== 'tile' || end.x !== t.x || end.y !== t.y) placeMark(this.goalMark, end, PLAYER_COLOR, 0.01);
    // Um ponto entre cada par de tiles e outro no centro de cada um, da saída até o destino, que já tem a marca.
    const m = new THREE.Matrix4();
    let n = 0;
    for (let i = 1; i < path.length && n < TRAIL_MAX - 1; i++) {
      const [a, b] = [path[i - 1], path[i]];
      this.trail.setMatrixAt(n++, m.makeTranslation((a.x + b.x) / 2, 0.014, (a.y + b.y) / 2));
      if (i < path.length - 1) this.trail.setMatrixAt(n++, m.makeTranslation(b.x, 0.014, b.y));
    }
    this.trail.count = n;
    this.trail.instanceMatrix.needsUpdate = true;
  }

  /**
   * Onde o jogador para se for até o alvo: o tile, ou o livre mais perto dele; o lado livre do móvel ou
   * da pessoa; e, para um item, o tile dele no chão ou o lado de quem o tem. Null se não houver.
   */
  private goalOf(world: WorldState, loc: Location, me: Character, from: Pos, t: Target, occupant: (x: number, y: number) => string | null): Pos | null {
    const beside = (r: GridRect) => besideRect(loc, r, from, (x, y) => ![null, me.id].includes(occupant(x, y)));
    const person = (id: string) => {
      const c = world.characters[id];
      return c?.pos && c.locationId === loc.id && c.id !== me.id ? beside({ ...c.pos, w: 1, h: 1 }) : null;
    };
    const fixture = (id: string) => {
      const f = loc.fixtures.find((x) => x.id === id);
      return f ? beside(f) : null;
    };
    if (t.kind === 'tile') return walkGoal(loc, t, occupant, me.id);
    if (t.kind === 'character') return person(t.id);
    if (t.kind === 'fixture') return fixture(t.id);
    const h = world.items[t.id]?.holder;
    if (!h) return null;
    if (h.kind === 'ground') return h.locationId === loc.id ? walkGoal(loc, h, occupant, me.id) : null;
    return h.kind === 'fixture' ? fixture(h.id) : person(h.id);
  }

  /** O que está sob o ponteiro: uma pessoa, um móvel ou um item, ou o tile do chão (para andar). */
  private pickAt(e: PointerEvent): Target | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.room.children, true).find((h) => h.object.userData.pick || h.object.userData.floor);
    if (!hit) return null;
    if (!hit.object.userData.floor) return hit.object.userData.pick as Pick;
    const p = this.room.worldToLocal(hit.point.clone());
    return { kind: 'tile', x: Math.round(p.x), y: Math.round(p.z) };
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private clearRoom(): void {
    this.surfaces.clear();
    this.spans.clear();
    this.areas.clear();
    for (const lamp of this.lamps.values()) lamp.dispose();
    this.lamps.clear();
    for (const id of [...this.balloons.keys()]) this.removeBalloon(id);
    for (const a of this.actors.values()) a.label.element.remove();
    this.actors.clear();
    for (const s of this.signs.values()) s.element.remove();
    this.signs.clear();
    this.items.clear();
    this.boards.clear();
    this.walls = [];
    this.decor = [];
    this.scene.remove(this.room);
    this.room.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.room = new THREE.Group();
    this.scene.add(this.room);
  }

  private buildRoom(world: WorldState | null, loc: Location | null): void {
    this.clearRoom();
    if (!loc) return;
    // Paredes, vergas e janelas com o material e a cor do lugar.
    setWallLook(locationLook(loc).walls);
    const interior = (x: number, y: number) => {
      const d = tileDef(loc, x, y);
      return d.kind !== 'void' && !d.wall;
    };

    const floorTiles: [number, number][] = [];
    for (let y = 0; y < loc.height; y++) {
      for (let x = 0; x < loc.width; x++) {
        const d = tileDef(loc, x, y);
        if (d.kind !== 'void') floorTiles.push([x, y]);
        if (d.kind !== 'wall') continue;
        const normal = new THREE.Vector2();
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (interior(x + dx, y + dy)) normal.add(new THREE.Vector2(-dx, -dy));
        if (normal.lengthSq() === 0) {
          for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (interior(x + dx, y + dy)) normal.add(new THREE.Vector2(-dx, -dy));
        }
        const wall = wallPiece();
        wall.position.set(x, 0, y);
        this.room.add(wall);
        this.walls.push({ obj: wall, normal: normal.lengthSq() ? normal.normalize() : null });
      }
    }
    const floor = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.1, 1), mat('#ffffff'), floorTiles.length);
    const m = new THREE.Matrix4();
    floorTiles.forEach(([x, y], i) => {
      floor.setMatrixAt(i, m.makeTranslation(x, -0.05, y));
      floor.setColorAt(i, floorColor(loc.floor, x, y));
    });
    floor.receiveShadow = true;
    floor.userData.floor = true;
    this.room.add(floor);

    for (const f of loc.fixtures) {
      const chain = typeChain(world, f.kind);
      const obj = buildFixture(f, chain);
      obj.name = `fixture:${f.id}`;
      tagPick(obj, { kind: 'fixture', id: f.id });
      this.room.add(obj);
      void this.upgradeFixture(obj, f, chain, loc.era);
      if (f.wall) {
        const [dx, dy] = DIR_VEC[f.facing];
        this.walls.push({ obj, normal: new THREE.Vector2(-dx, -dy) });
      }
      if (f.kind === 'board') {
        const surface = obj.getObjectByName('board-surface') as THREE.Mesh;
        this.boards.set(f.id, { surface, text: '\u0000', length: f.facing === 'N' || f.facing === 'S' ? f.w : f.h });
      }
      if (loc.exits?.[f.id]) {
        const el = document.createElement('button');
        el.className = 'exit-sign';
        el.addEventListener('click', () => this.select({ kind: 'fixture', id: f.id }));
        const sign = new CSS2DObject(el);
        const [dx, dz] = DIR_VEC[f.facing];
        sign.position.set(f.x + (f.w - 1) / 2 + dx * 0.6, 2.6, f.y + (f.h - 1) / 2 + dz * 0.6);
        sign.userData.wall = obj;
        this.room.add(sign);
        this.signs.set(f.id, sign);
      }
    }
    if (world) void this.dressRoom(world, loc);
    this.frame(loc);
  }

  /**
   * O que dá a cara da época ao cômodo, quando os modelos carregam: a folha da porta no lugar da de
   * primitivas, e a decoração pendurada nas paredes (decorSpots), virada para dentro.
   */
  private async dressRoom(world: WorldState, loc: Location): Promise<void> {
    const room = this.room;
    const door = loc.era && !loc.outdoor ? ERA_DOORS[loc.era] : undefined;
    const leaf = door ? await catalogProp(door) : null;
    if (leaf && this.room === room) {
      for (const f of loc.fixtures) {
        if (!typeChain(world, f.kind).some((t) => t.id === 'door')) continue;
        const hinges: THREE.Object3D[] = [];
        this.room.getObjectByName(`fixture:${f.id}`)?.traverse((o) => o.name === 'door-hinge' && hinges.push(o));
        for (const hinge of hinges) {
          const { side, span } = hinge.userData as { side: number; span: number };
          const old = hinge.getObjectByName('door-leaf');
          if (old) hinge.remove(old);
          const fitted = fitted2D(leaf.obj, leaf.size, span, 2.0, false);
          fitted.name = 'door-leaf';
          fitted.position.x = (-side * span) / 2;
          hinge.add(fitted);
        }
      }
    }
    const loads = new Map<string, Promise<{ obj: THREE.Object3D; size: [number, number, number] } | null>>();
    for (const spot of decorSpots(world, loc)) {
      const id = decorModel(spot.kind, loc.era);
      if (!id) continue;
      if (!loads.has(id)) loads.set(id, catalogProp(id));
      void loads.get(id)!.then((model) => {
        if (model && this.room === room) this.hang(spot, model);
      });
    }
  }

  /** Pendura uma decoração no ponto de parede, encostada nela e virada para o cômodo. */
  private hang(spot: DecorSpot, model: { obj: THREE.Object3D; size: [number, number, number] }): void {
    const fit = DECOR_FIT[spot.kind] ?? DECOR_FIT.quadros;
    const obj = fitted2D(model.obj, model.size, fit.w, fit.h, true);
    const box = new THREE.Box3().setFromObject(obj);
    const [h, depth] = [box.max.y - box.min.y, box.max.z - box.min.z];
    const out = 0.5 + depth / 2 + 0.01;
    obj.position.set(spot.x + spot.dx * out, fit.top ? fit.y - h : fit.y - h / 2, spot.y + spot.dy * out);
    obj.rotation.y = Math.atan2(spot.dx, spot.dy);
    this.room.add(obj);
    const wall = this.walls.find((w) => w.obj.position.x === spot.x && w.obj.position.z === spot.y)?.obj;
    if (wall) this.decor.push({ obj, wall });
  }

  /** Troca o boneco primitivo pelo personagem animado do catálogo, quando ele carrega e se houver. */
  private async upgradeActor(actor: Actor, c: Character): Promise<void> {
    const room = this.room;
    const model = await characterModel(c);
    if (!model || this.room !== room || this.actors.get(c.id) !== actor) return;
    const body = actor.obj.userData.body as THREE.Object3D | undefined;
    if (body) actor.obj.remove(body);
    actor.obj.add(model.root);
    tagPick(actor.obj, { kind: 'character', id: c.id });
    actor.model = model;
    void this.play(actor, actor.poseClip);
  }

  /**
   * Troca o clipe do corpo inteiro com uma transição curta, carregando o clipe se preciso; `once`
   * toca uma vez (e `clamp` para no último quadro, como quem cai). Se outro clipe for pedido
   * enquanto este carrega, fica o outro.
   */
  private async play(actor: Actor, clip: Clip, opts: { once?: boolean; clamp?: boolean; fade?: number } = {}): Promise<THREE.AnimationAction | null> {
    const model = actor.model;
    if (!model) return null;
    actor.clip = clip;
    const next = await loadAction(model, clip);
    if (actor.model !== model || actor.clip !== clip) return null;
    if (!next) {
      actor.missing.add(clip);
      if (clip !== 'idle') return this.play(actor, 'idle', opts);
      return null;
    }
    const fade = opts.fade ?? 0.25;
    const previous = actor.current;
    next.reset();
    next.setLoop(opts.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = Boolean(opts.clamp);
    next.setEffectiveWeight(1);
    next.fadeIn(fade).play();
    if (previous && previous !== next) previous.fadeOut(fade);
    actor.current = next;
    return next;
  }

  /**
   * Um gesto de um instante. De pé, o corpo inteiro faz o gesto e volta à pose; sentado ou
   * ajoelhado, só o tronco e os braços (por cima da pose); deitado ou caído, nada. `yaw` vira a
   * pessoa para o alvo enquanto dura.
   */
  private async gesture(actor: Actor, clip: Clip, yaw: number | null): Promise<void> {
    const model = actor.model;
    if (!model || actor.stance === 'chao' || actor.obj.position.distanceTo(actor.target) > 0.06) return;
    const upper = actor.stance === 'baixo';
    if (actor.gesture?.upper) actor.gesture.action?.stop();
    // O gesto vale desde já, enquanto o clipe carrega: a pose não volta por cima dele.
    const pending = { action: null, start: this.clock.elapsedTime, until: this.clock.elapsedTime + 5, upper, yaw };
    actor.gesture = pending;
    const action = upper ? await loadUpperAction(model, clip) : await this.play(actor, clip, { once: true });
    if (actor.gesture !== pending) return;
    if (!action || actor.model !== model) {
      actor.gesture = undefined;
      return;
    }
    const now = this.clock.elapsedTime;
    if (upper) {
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = false;
      action.setEffectiveWeight(0);
      action.play();
      actor.gesture = { action, start: now, until: now + action.getClip().duration, upper, yaw };
      return;
    }
    // A transição de volta começa um pouco antes do fim, com o gesto ainda em movimento.
    actor.gesture = { action, start: now, until: now + Math.max(0.3, action.getClip().duration - 0.25), upper, yaw };
  }

  /**
   * Gestos marcados na narração (`{id:gesto>alvo}`), no passo do replay em que acontecem: o clipe
   * vem da arma na mão (ataca com pistola atira, com espada golpeia) e do lado de onde está o alvo.
   */
  act(acts: Act[]): void {
    if (!this.shown) return;
    const { world, loc } = this.shown;
    for (const act of acts) {
      const actor = this.actors.get(act.actorId);
      const def = GESTURES[act.gesture];
      if (!actor || !def) continue;
      const target = act.targetId ? this.pointOf(world, loc, act.targetId) : null;
      const toward = target ? Math.atan2(target.x - actor.obj.position.x, target.z - actor.obj.position.z) : null;
      let clip = clipFor(def.clip, actor.grip, `${act.actorId}:${act.gesture}:${act.targetId ?? ''}`);
      if (def.sides && toward !== null) {
        const rel = Math.atan2(Math.sin(toward - actor.obj.rotation.y), Math.cos(toward - actor.obj.rotation.y));
        const side = Math.abs(rel) < Math.PI / 4 ? 'frente' : Math.abs(rel) > (3 * Math.PI) / 4 ? 'tras' : rel > 0 ? 'esquerda' : 'direita';
        clip = def.sides[side];
      }
      void this.gesture(actor, clip, def.face ? toward : null);
      if (def.attack && actor.grip && GRIPS[actor.grip].ranged) this.shot(actor, target);
    }
  }

  /** Onde fica um personagem (à altura do peito) ou o centro de um móvel do local. */
  private pointOf(world: WorldState, loc: Location, id: string): THREE.Vector3 | null {
    const actor = this.actors.get(id);
    if (actor) return actor.obj.position.clone().add(new THREE.Vector3(0, actor.stance === 'chao' ? 0.3 : 1.3, 0));
    const f = loc.fixtures.find((x) => x.id === id || x.id.endsWith(`/${id}`));
    if (f) return new THREE.Vector3(f.x + (f.w - 1) / 2, 0.9, f.y + (f.h - 1) / 2);
    const c = world.characters[id];
    return c?.pos && c.locationId === loc.id ? new THREE.Vector3(c.pos.x, 1.3, c.pos.y) : null;
  }

  /**
   * O tiro: clarão no cano um instante depois do gatilho e o rastro até o alvo. Arco solta a
   * flecha mais tarde, quando a corda volta.
   */
  private shot(actor: Actor, target: THREE.Vector3 | null): void {
    const held = actor.held.get('direita') ?? actor.held.get('esquerda');
    const bow = actor.grip === 'arco';
    const firearm = actor.grip !== null && FIREARMS.has(actor.grip);
    setTimeout(() => {
      const obj = held?.model?.obj;
      if (!obj?.parent) return;
      const muzzle = held!.model!.tip.clone().applyMatrix4(obj.matrixWorld);
      const parts: THREE.Object3D[] = [];
      if (firearm) {
        const flash = new THREE.PointLight('#ffb35a', 14, 5, 1.5);
        flash.position.copy(muzzle);
        const spark = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffe08a' }));
        spark.position.copy(muzzle);
        parts.push(flash, spark);
      }
      if (target) {
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([muzzle, target]),
          new THREE.LineBasicMaterial({ color: bow ? '#c9b28a' : '#fff1b0', transparent: true, opacity: bow ? 0.7 : 0.9 }),
        );
        parts.push(line);
      }
      for (const p of parts) this.room.add(p);
      setTimeout(() => {
        for (const p of parts) {
          p.removeFromParent();
          if (p instanceof THREE.Mesh || p instanceof THREE.Line) p.geometry.dispose();
          if (p instanceof THREE.PointLight) p.dispose();
        }
      }, bow ? 220 : 90);
    }, bow ? 250 : 70);
  }

  /** Troca as primitivas do móvel pelo modelo do catálogo (o da época do lugar), quando ele carrega e se houver. */
  private async upgradeFixture(obj: THREE.Group, f: Fixture, chain: ObjectType[], era: Location['era']): Promise<void> {
    const room = this.room;
    const model = await fixtureModel(f, chain, era);
    if (!model || this.room !== room) return;
    for (const child of [...obj.children]) {
      child.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      obj.remove(child);
    }
    // Objeto de parede com modelo (quadro, telão): a parede continua atrás dele.
    if (f.wall) {
      const wall = wallPiece();
      wall.scale.x = f.facing === 'N' || f.facing === 'S' ? f.w : f.h;
      obj.add(wall);
    }
    obj.add(model.group);
    tagPick(obj, { kind: 'fixture', id: f.id });
    this.surfaces.set(f.id, model.top);
    this.spans.set(f.id, model.span);
    this.areas.set(f.id, model.area);
    // Com o modelo, quem está sentado nele e o que está em cima mudam de lugar.
    if (this.shown) {
      this.syncActors(this.shown.world, this.shown.loc);
      this.syncItems(this.shown.world, this.shown.loc);
    }
  }

  private frame(loc: Location): void {
    const cx = (loc.width - 1) / 2;
    const cz = (loc.height - 1) / 2;
    const size = Math.max(loc.width, loc.height);
    const dist = size * 1.05 + 5;
    const elevation = THREE.MathUtils.degToRad(50);
    const azimuth = THREE.MathUtils.degToRad(18);
    this.controls.target.set(cx, 0.5, cz);
    this.camera.position.set(
      cx + dist * Math.cos(elevation) * Math.sin(azimuth),
      dist * Math.sin(elevation),
      cz + dist * Math.cos(elevation) * Math.cos(azimuth),
    );
    this.controls.update();
    this.sun.position.set(cx - size * 0.5, size + 8, cz - size * 0.35);
    this.sun.target.position.set(cx, 0, cz);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -size;
    cam.right = cam.top = size;
    cam.far = size * 4 + 30;
    cam.updateProjectionMatrix();
  }

  private syncBoards(loc: Location): void {
    for (const f of loc.fixtures) {
      const board = this.boards.get(f.id);
      if (!board || board.text === f.text) continue;
      const material = board.surface.material as THREE.MeshStandardMaterial;
      material.map?.dispose();
      material.map = drawBoard(f.text, board.length);
      material.needsUpdate = true;
      board.text = f.text;
    }
  }

  private syncSigns(loc: Location): void {
    for (const [id, sign] of this.signs) {
      const f = loc.fixtures.find((x) => x.id === id);
      const exit = loc.exits?.[id];
      if (!f || !exit) continue;
      const text = `${EXIT_ICON[f.kind] ?? ''} ${exit.label}`.trim();
      if (sign.element.textContent !== text) sign.element.textContent = text;
    }
  }

  private placement(world: WorldState, c: Character, loc: Location): { pos: THREE.Vector3; yaw: number; seated: boolean } {
    const pos = new THREE.Vector3(c.pos!.x, 0, c.pos!.y);
    const seat = c.seatId ? loc.fixtures.find((f) => f.id === c.seatId) : undefined;
    if (!seat) return { pos, yaw: YAW[c.facing], seated: false };
    const yaw = YAW[seat.facing];
    const chain = typeChain(world, seat.kind);
    if (chain.some((t) => t.bed)) {
      // Deitado na cama, ao comprido: a frente da cama é o pé, e a cabeça vai para o travesseiro, no
      // lado oposto. O quadril fica a meio corpo (0,95 m) da cabeceira do modelo; antes de ele
      // carregar, um pouco abaixo do meio do espaço da cama (que cresce para o pé no layout antigo).
      const top = this.surfaces.get(seat.id) ?? chain.map((t) => t.surface).find((v) => v !== undefined) ?? 0.5;
      const center = new THREE.Vector3(seat.x + (seat.w - 1) / 2, top, seat.y + (seat.h - 1) / 2);
      if (bodyPose(world, c) === 'sentado') return this.bedEdge(loc, seat, center, yaw);
      const head = this.areas.get(seat.id)?.z0;
      const ahead = head !== undefined ? head + 0.95 : 0.3 + footprint(seat, chain).shift;
      return { pos: center.add(new THREE.Vector3(ahead * Math.sin(yaw), 0, ahead * Math.cos(yaw))), yaw, seated: false };
    }
    const kinds = chain.map((t) => t.id);
    // Assento comprido com modelo mais curto que os tiles: quem senta fica dentro do modelo.
    const alongX = seat.facing === 'N' || seat.facing === 'S';
    const length = alongX ? seat.w : seat.h;
    const span = this.spans.get(seat.id);
    if (span !== undefined && length > 1) {
      const k = Math.min(1, Math.max(0, span - 0.6) / (length - 1));
      if (alongX) pos.x = seat.x + (seat.w - 1) / 2 + (pos.x - seat.x - (seat.w - 1) / 2) * k;
      else pos.z = seat.y + (seat.h - 1) / 2 + (pos.z - seat.y - (seat.h - 1) / 2) * k;
    }
    const back = kinds.map(seatOffset).find((v) => v !== null) ?? (kinds.includes('desk') ? -0.3 : kinds.includes('sofa') ? -0.1 : 0);
    pos.add(new THREE.Vector3(back * Math.sin(yaw), 0, back * Math.cos(yaw)));
    return { pos, yaw, seated: true };
  }

  /**
   * Sentado na beirada da cama: no meio do lado comprido, virado para fora, do lado livre que dá
   * para o meio do quarto. Senta como numa cadeira, na altura do colchão.
   */
  private bedEdge(loc: Location, seat: Fixture, center: THREE.Vector3, yaw: number): { pos: THREE.Vector3; yaw: number; seated: boolean } {
    const area = this.areas.get(seat.id);
    const half = area ? (area.x1 - area.x0) / 2 : 0.45;
    const mid = area ? (area.z0 + area.z1) / 2 : 0;
    const along = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const sides = [yaw + Math.PI / 2, yaw - Math.PI / 2].map((a) => ({ a, dir: new THREE.Vector3(Math.sin(a), 0, Math.cos(a)) }));
    const room = (s: (typeof sides)[number]) => {
      const out = center.clone().addScaledVector(s.dir, half + 0.5);
      return isPassable(loc, Math.round(out.x), Math.round(out.z));
    };
    // Dos lados livres, o que dá para o meio do quarto.
    const middle = new THREE.Vector3((loc.width - 1) / 2 - center.x, 0, (loc.height - 1) / 2 - center.z);
    const side = [...sides].sort((a, b) => Number(room(b)) - Number(room(a)) || b.dir.dot(middle) - a.dir.dot(middle))[0];
    const pos = new THREE.Vector3(center.x, 0, center.z).addScaledVector(along, mid).addScaledVector(side.dir, Math.max(0, half - 0.15));
    return { pos, yaw: side.a, seated: true };
  }

  /**
   * A pose do corpo, pelo motor (body.ts), e o clipe dela conforme a arma na mão. Quem cai agora
   * (não quem já estava caído quando a cena abriu) passa pelo clipe da queda. Com alvo (mirando,
   * apontando), o corpo se volta para ele em qualquer ângulo.
   */
  private pose(actor: Actor, world: WorldState, c: Character, loc: Location, yaw: number): void {
    const pose = bodyPose(world, c);
    const def = POSES[pose] ?? POSES.de_pe;
    const grip = mainGrip(world, c.id)?.grip ?? null;
    const previous = actor.pose;
    actor.pose = pose;
    actor.grip = grip;
    actor.stance = def.ground ? 'chao' : actor.seated || LOW_POSES.has(pose) ? 'baixo' : 'pe';
    actor.poseClip = actor.seated ? 'sit' : clipFor(def.clip, grip, c.id);
    if (previous && pose !== previous && def.enter && actor.model) {
      const enter = def.enter[variantIndex(def.enter.length, c.id)];
      void this.fall(actor, enter);
    }
    const target = c.poseTarget ? this.pointOf(world, loc, c.poseTarget) : null;
    actor.yaw = target ? Math.atan2(target.x - actor.target.x, target.z - actor.target.z) : yaw;
  }

  /** Clipe de entrada numa pose (a queda de quem morre), que para no último quadro até a pose assumir. */
  private async fall(actor: Actor, clip: Clip): Promise<void> {
    const now = this.clock.elapsedTime;
    actor.gesture = { action: null, start: now, until: now + 5, upper: false, yaw: null };
    const action = await this.play(actor, clip, { once: true, clamp: true });
    if (actor.gesture?.start === now) {
      if (action) actor.gesture = { action, start: now, until: now + action.getClip().duration, upper: false, yaw: null };
      else actor.gesture = undefined;
    }
  }

  /** O que a pessoa tem nas mãos, com o modelo de cada item (ou a primitiva, enquanto carrega ou sem modelo). */
  private syncHeld(actor: Actor, world: WorldState, c: Character): void {
    const hands = handsOf(world, c.id);
    const wanted = new Map<Hand, Item>();
    if (hands.direita) wanted.set('direita', hands.direita);
    if (hands.esquerda && hands.esquerda !== hands.direita) wanted.set('esquerda', hands.esquerda);
    for (const [hand, h] of actor.held) {
      const item = wanted.get(hand);
      if (item && h.key === heldKey(item)) continue;
      h.model?.obj.removeFromParent();
      actor.held.delete(hand);
    }
    for (const [hand, item] of wanted) {
      if (actor.held.has(hand)) continue;
      const h: Held = { key: heldKey(item), grip: gripOf(item), model: null };
      actor.held.set(hand, h);
      const room = this.room;
      void heldModel(item, h.grip).then((model) => {
        if (actor.held.get(hand) !== h || this.room !== room) return;
        h.model = model;
        room.add(model.obj);
      });
    }
  }

  /**
   * Põe o item na mão a cada quadro, pela posição do pulso e das juntas dos dedos (não depende de
   * como cada esqueleto orienta os ossos): o cano segue a mão, a lâmina sai do lado do polegar. O
   * fuzil aponta do punho para a mão de apoio quando ela está à frente.
   */
  private placeHeld(a: Actor, hand: Hand, h: Held): void {
    const obj = h.model?.obj;
    if (!obj) return;
    const bones = a.model?.hands[hand];
    obj.visible = Boolean(bones);
    if (!bones) return;
    const wrist = bones.wrist.getWorldPosition(V1);
    const index = bones.index.getWorldPosition(V2);
    const finger = bones.finger.getWorldPosition(V3);
    const knuckles = index.clone().add(finger).multiplyScalar(0.5);
    const fwd = knuckles.clone().sub(wrist).normalize();
    const thumb = index.clone().sub(finger);
    thumb.addScaledVector(fwd, -thumb.dot(fwd)).normalize();
    const palm = hand === 'direita' ? thumb.clone().cross(fwd) : fwd.clone().cross(thumb);
    const grip = wrist.clone().lerp(knuckles, 0.6).addScaledVector(palm, 0.025);
    let z = fwd;
    let y = thumb;
    const support = a.model?.hands.esquerda;
    if (h.grip === 'arma_longa' && support) {
      const other = support.wrist.getWorldPosition(new THREE.Vector3()).lerp(support.index.getWorldPosition(new THREE.Vector3()), 0.6);
      const along = other.sub(grip);
      const d = along.length();
      const facing = new THREE.Vector3(Math.sin(a.obj.rotation.y), 0, Math.cos(a.obj.rotation.y));
      if (d > 0.15 && d < 1 && along.dot(facing) > 0.3 * d) {
        z = along.normalize();
        y = thumb.clone().addScaledVector(z, -thumb.dot(z)).normalize();
      }
    } else if (h.grip === 'escudo') {
      z = palm.clone().negate();
      y = fwd.clone().cross(z).normalize();
    }
    const shaft = h.model?.shaft;
    if (shaft && h.grip === 'duas_maos' && a.pose === 'de_pe' && !a.gesture) {
      // Lança ou cajado em descanso: em pé ao lado do corpo, com a ponta de baixo no chão.
      y = new THREE.Vector3(0, 1, 0);
      z = new THREE.Vector3(Math.sin(a.obj.rotation.y), 0, Math.cos(a.obj.rotation.y));
      shaft.inner.position.y = shaft.slide + a.obj.position.y + 0.02 - grip.y - shaft.low;
    } else if (shaft) shaft.inner.position.y = shaft.slide;
    BASIS.makeBasis(y.clone().cross(z), y, z);
    obj.quaternion.setFromRotationMatrix(BASIS);
    obj.position.copy(grip);
    obj.scale.setScalar(a.obj.scale.x);
  }

  /** Item no chão ou num móvel com modelo do catálogo: troca a primitiva pelo modelo quando ele carrega. */
  private async upgradeItem(obj: THREE.Object3D, item: Item): Promise<void> {
    const room = this.room;
    const model = await groundModel(item);
    if (!model || this.room !== room || this.items.get(item.id) !== obj) return;
    const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    for (const child of [...obj.children]) obj.remove(child);
    obj.add(model);
    tagPick(obj, { kind: 'item', id: item.id });
    // Com o tamanho de verdade, os itens se rearranjam para não ficar um dentro do outro.
    this.itemSizes.set(item.id, [size.x, size.z]);
    if (this.shown) this.syncItems(this.shown.world, this.shown.loc);
  }

  /**
   * O caminho de quem mudou de lugar, pelo mesmo A* do motor, desviando de quem está parado. O último
   * ponto é o lugar exato (no assento, com o ajuste dele). Sem caminho, a pessoa desliza como antes.
   */
  private walk(actor: Actor, world: WorldState, loc: Location, c: Character, pos: THREE.Vector3): boolean {
    if (!c.pos) return false;
    const from = { x: Math.round(actor.obj.position.x), y: Math.round(actor.obj.position.z) };
    const people = new Set(
      Object.values(world.characters)
        .filter((o) => o.id !== c.id && o.locationId === loc.id && o.pos)
        .map((o) => `${o.pos!.x},${o.pos!.y}`),
    );
    const tiles = findPath(loc, from, c.pos, (x, y) => people.has(`${x},${y}`));
    if (!tiles || tiles.length < 2) return false;
    actor.route = [...tiles.slice(1, -1).map((t) => new THREE.Vector3(t.x, pos.y, t.y)), pos.clone()];
    const length = actor.route.reduce((sum, p, i) => sum + p.distanceTo(i ? actor.route[i - 1] : actor.obj.position), 0);
    // Passo de quem anda; num caminho longo, mais depressa, para chegar em até três segundos.
    actor.speed = Math.max(2.2, length / 3);
    return true;
  }

  private syncActors(world: WorldState, loc: Location): void {
    const present = new Set<string>();
    const view = perceptionOf(world, world.playerId);
    const life = lifeStatId(world);
    const lifeMax = world.ruleset.resources.find((r) => r.id === life)?.max ?? 1;
    for (const c of Object.values(world.characters)) {
      if (c.locationId !== loc.id || !c.pos) continue;
      present.add(c.id);
      const { pos, yaw, seated } = this.placement(world, c, loc);
      let actor = this.actors.get(c.id);
      if (!actor) {
        const obj = buildCharacter(c);
        obj.position.copy(pos);
        obj.rotation.y = yaw;
        obj.scale.setScalar(0.01);
        if (c.isPlayer) obj.add(playerRing(PLAYER_COLOR));
        tagPick(obj, { kind: 'character', id: c.id });
        const el = document.createElement('div');
        el.className = c.isPlayer ? 'name player' : 'name';
        const label = new CSS2DObject(el);
        obj.add(label);
        this.room.add(obj);
        actor = { obj, label, target: pos.clone(), yaw, seated: false, route: [], speed: 2.2, walkYaw: yaw, missing: new Set(), pose: '', poseClip: 'idle', stance: 'pe', grip: null, held: new Map() };
        this.actors.set(c.id, actor);
        void this.upgradeActor(actor, c);
      }
      // Nome só de quem o jogador sabe quem é (pelo rosto ou pela voz); estranho visto vira a
      // descrição; vulto que ele não reconhece, "?"; quem ele nem vê nem reconhece, nada.
      const sight = c.isPlayer ? 'nitido' : view.sight(c.id);
      const known = c.isPlayer || Boolean(view.recognize(c.id));
      const label = actor.label.element;
      label.replaceChildren(
        c.isPlayer ? `${c.name} (você)` : known ? c.name.split(' ')[0] : sight === 'nitido' ? capitalize(strangerLabel(c)) : '?',
      );
      label.classList.toggle('vulto', sight !== 'nitido');
      label.classList.toggle('stranger', !known && sight === 'nitido');
      // 💬: tem fala do turno que o jogador ainda não ouviu, como os NPCs que chamam atenção em Persona.
      label.classList.toggle('news', !c.isPlayer && sight === 'nitido' && hasNews(c));
      actor.label.visible = sight !== 'nada' || known;
      // Barra de vida só quando o jogador vê a pessoa e pode ver a vida dela (pública ou por perk).
      if (life && sight === 'nitido' && view.canSeeStat(life, c.id)) {
        const value = c.resources[life] ?? lifeMax;
        const bar = document.createElement('span');
        bar.className = 'hp';
        bar.title = `${value}/${lifeMax}`;
        const fill = document.createElement('i');
        fill.style.width = `${(100 * value) / lifeMax}%`;
        bar.append(fill);
        label.append(bar);
      }
      // Mudou de lugar: anda pelo caminho do grid, tile a tile, em vez de deslizar reto até lá.
      const walking = actor.target.distanceTo(pos) > 0.5 && this.walk(actor, world, loc, c, pos);
      actor.target.copy(pos);
      if (walking) {
        // Levanta antes de sair andando; senta quando chegar.
        if (actor.seated) setSeated(actor.obj, false);
        actor.sitOnArrival = seated;
      } else if (actor.seated !== seated && !actor.route.length) setSeated(actor.obj, seated);
      actor.seated = seated;
      this.pose(actor, world, c, loc, yaw);
      actor.label.position.set(0, labelHeight(actor), 0);
      this.syncHeld(actor, world, c);
    }
    for (const [id, actor] of this.actors) {
      if (present.has(id)) continue;
      this.removeBalloon(id);
      actor.label.element.remove();
      for (const h of actor.held.values()) h.model?.obj.removeFromParent();
      this.room.remove(actor.obj);
      this.actors.delete(id);
    }
  }

  private syncItems(world: WorldState, loc: Location): void {
    const spots = this.itemSpots(world, loc);
    for (const item of Object.values(world.items)) {
      const spot = spots.get(item.id);
      if (!spot) continue;
      let obj = this.items.get(item.id);
      if (!obj) {
        obj = buildItem(item);
        tagPick(obj, { kind: 'item', id: item.id });
        this.room.add(obj);
        this.items.set(item.id, obj);
        void this.upgradeItem(obj, item);
      }
      obj.position.copy(spot.pos);
      obj.rotation.y = spot.yaw;
    }
    for (const [id, obj] of this.items) {
      if (spots.has(id)) continue;
      this.room.remove(obj);
      this.items.delete(id);
    }
  }

  /**
   * Onde fica cada item em cena: no chão, no tile dele; num móvel, no tampo do modelo, alinhado
   * com ele. Dois corpos não ocupam o mesmo lugar: o item desvia de quem está ali (deitado na cama
   * de ponta a ponta, sentado no assento, de pé no tile) e dos outros itens.
   */
  private itemSpots(world: WorldState, loc: Location): Map<string, { pos: THREE.Vector3; yaw: number }> {
    const spots = new Map<string, { pos: THREE.Vector3; yaw: number }>();
    const ground = new Map<string, { x: number; y: number; items: Item[] }>();
    const onFixture = new Map<string, Item[]>();
    for (const item of Object.values(world.items)) {
      const h = item.holder;
      if (h.kind === 'ground' && h.locationId === loc.id) {
        const tile = ground.get(`${h.x},${h.y}`) ?? { x: h.x, y: h.y, items: [] };
        tile.items.push(item);
        ground.set(`${h.x},${h.y}`, tile);
      }
      if (h.kind === 'fixture') onFixture.set(h.id, [...(onFixture.get(h.id) ?? []), item]);
    }
    const people = Object.values(world.characters).filter((c) => c.locationId === loc.id && c.pos);
    const spot = (item: Item, x: number, z: number): Spot => {
      const [w, d] = this.itemSizes.get(item.id) ?? [0.2, 0.14];
      return { id: item.id, w, d, x, z };
    };
    for (const { x, y, items } of ground.values()) {
      const standing = people.filter((c) => !c.seatId && c.pos!.x === x && c.pos!.y === y).map(() => around(x, y, 0.25));
      const placed = arrange(
        around(x, y, 0.45),
        standing,
        items.map((item) => {
          const s = hash(item.id);
          return spot(item, x + ((s % 30) - 15) / 100, y + (((s >>> 8) % 30) - 15) / 100);
        }),
      );
      for (const [id, p] of placed) spots.set(id, { pos: new THREE.Vector3(p.x, 0.01, p.z), yaw: p.turned ? Math.PI / 2 : 0 });
    }
    for (const [id, items] of onFixture) {
      const f = loc.fixtures.find((fx) => fx.id === id);
      if (!f) continue;
      const chain = typeChain(world, f.kind);
      const surface = chain.map((t) => t.surface).find((v) => v !== undefined);
      const center = new THREE.Vector3(f.x + (f.w - 1) / 2, 0, f.y + (f.h - 1) / 2);
      if (f.kind === 'board') {
        const [dx, dz] = DIR_VEC[f.facing];
        for (const item of items) {
          const s = hash(item.id);
          spots.set(item.id, { pos: new THREE.Vector3(center.x + ((s % 60) - 30) / 100 + dx * 0.58, surface ?? 0.97, center.z + dz * 0.58), yaw: 0 });
        }
        continue;
      }
      const yaw = YAW[f.facing];
      const room = footprint(f, chain);
      // Antes de o modelo carregar, o miolo do espaço do móvel.
      const area = this.areas.get(f.id) ?? { x0: -room.w * 0.35, z0: room.shift - room.d * 0.35, x1: room.w * 0.35, z1: room.shift + room.d * 0.35 };
      const bed = chain.some((t) => t.bed);
      const blocked = people
        .filter((c) => c.seatId === f.id)
        .map((c) => {
          const p = this.placement(world, c, loc).pos.sub(center).applyAxisAngle(UP, -yaw);
          // Deitado, o corpo ocupa a cama de ponta a ponta numa faixa no meio; sentado, o assento.
          return bed && bodyPose(world, c) === 'deitado' ? { x0: p.x - 0.28, z0: area.z0, x1: p.x + 0.28, z1: area.z1 } : around(p.x, p.z, 0.3);
        });
      // A carteira tem o tampo na frente de quem senta.
      const mid = { x: (area.x0 + area.x1) / 2, z: (area.z0 + area.z1) / 2 + (f.kind === 'desk' ? 0.16 : 0) };
      const placed = arrange(
        area,
        blocked,
        items.map((item) => {
          const s = hash(item.id);
          return spot(item, mid.x + ((s % 40) - 20) / 100, mid.z + (((s >>> 8) % 30) - 15) / 100);
        }),
      );
      const top = this.surfaces.get(f.id) ?? surface ?? 0.8;
      for (const [itemId, p] of placed) {
        spots.set(itemId, { pos: new THREE.Vector3(p.x, top, p.z).applyAxisAngle(UP, yaw).add(center), yaw: yaw + (p.turned ? Math.PI / 2 : 0) });
      }
    }
    return spots;
  }

  /**
   * Luz da cena: a ambiente do local, as lanternas e os poderes de luz. Depois a visão do jogador:
   * cegueira e vista turva escurecem e borram o palco inteiro, sem chegar ao preto.
   */
  private syncLight(world: WorldState, loc: Location): void {
    const vision = world.playerId ? visionOf(world, world.playerId) : { acuity: 1, darkvision: 0 };
    const ambient = loc.light ?? 1;
    // Quem enxerga no escuro vê a sala em tons apagados, mesmo sem luz.
    const seen = vision.darkvision > 0 ? Math.max(ambient, 0.55) : ambient;
    this.sky.intensity = 0.1 + 1.4 * seen;
    this.sun.intensity = 2.4 * ambient;
    const live = new Set<string>();
    for (const s of lightSources(world, loc.id)) {
      live.add(s.id);
      let lamp = this.lamps.get(s.id);
      if (!lamp) {
        lamp = new THREE.PointLight(s.color, 1, 0, 1);
        this.lamps.set(s.id, lamp);
      }
      const carrier = s.carrierId ? this.actors.get(s.carrierId)?.obj : undefined;
      const parent = carrier ?? this.items.get(s.id) ?? this.room;
      if (lamp.parent !== parent) parent.add(lamp);
      if (carrier) lamp.position.set(0.22, 1.2, 0.3);
      else if (parent === this.room) lamp.position.set(s.pos.x, 1.2, s.pos.y);
      else lamp.position.set(0, 0.35, 0);
      lamp.color.set(s.color);
      // Alcance e queda parecidos com os do motor (light.ts), para o que se vê bater com o que conta.
      lamp.intensity = 3 + 9 * s.intensity;
      lamp.distance = s.radius + 2.5;
    }
    for (const [id, lamp] of this.lamps) {
      if (live.has(id)) continue;
      lamp.removeFromParent();
      lamp.dispose();
      this.lamps.delete(id);
    }
    const acuity = Math.min(1, vision.acuity);
    const loss = 1 - acuity;
    const filters = [];
    if (loss > 0) filters.push(`brightness(${(0.22 + 0.78 * acuity).toFixed(2)})`, `blur(${(loss * 3).toFixed(1)}px)`, `saturate(${(0.35 + 0.65 * acuity).toFixed(2)})`);
    if (vision.darkvision > 0 && ambient < 0.5) filters.push('grayscale(0.7)');
    this.renderer.domElement.style.filter = filters.join(' ');
    this.veil.style.opacity = (loss * 0.85).toFixed(2);
  }

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.controls.update();
    const now = this.clock.elapsedTime;
    for (const a of this.actors.values()) {
      const next = a.route[0];
      const moving = Boolean(next) || a.obj.position.distanceTo(a.target) > 0.06;
      if (a.model) {
        a.model.mixer.update(dt);
        // Gesto acaba no tempo dele, ou quando a pessoa sai andando.
        const g = a.gesture;
        if (g && (now >= g.until || moving)) {
          if (g.upper) g.action?.stop();
          a.gesture = undefined;
        } else if (g?.upper && g.action) {
          // Só no tronco, por cima da pose: o peso sobe e desce nas pontas (peso p dá p/(1+p) do gesto).
          const t = now - g.start;
          const b = Math.min(1, t / 0.25, (g.until - g.start - t) / 0.25);
          g.action.setEffectiveWeight(b <= 0 ? 0 : b >= 0.98 ? 50 : b / (1 - b));
        }
        const want = moving ? 'walk' : a.missing.has(a.poseClip) ? 'idle' : a.poseClip;
        if (!(a.gesture && !a.gesture.upper) && a.clip !== want) void this.play(a, want);
      }
      if (next) {
        // Anda até o próximo tile do caminho, virado para onde vai.
        const to = V3.copy(next).sub(a.obj.position);
        const d = to.length();
        const step = a.speed * dt;
        if (d > 0.05) a.walkYaw = Math.atan2(to.x, to.z);
        if (d <= step) {
          a.obj.position.copy(next);
          a.route.shift();
          if (!a.route.length && a.sitOnArrival) {
            setSeated(a.obj, true);
            a.sitOnArrival = false;
          }
        } else a.obj.position.addScaledVector(to, step / d);
      } else a.obj.position.lerp(a.target, 1 - Math.exp(-dt * 5));
      a.obj.rotation.y = lerpAngle(a.obj.rotation.y, a.gesture?.yaw ?? (next ? a.walkYaw : a.yaw), 1 - Math.exp(-dt * 8));
      if (a.obj.scale.x < 1) a.obj.scale.setScalar(Math.min(1, a.obj.scale.x + dt * 3));
      for (const [hand, h] of a.held) this.placeHeld(a, hand, h);
      // No chão, o corpo não fica onde a pessoa estava de pé (quem cai vai para trás): o nome segue a cabeça.
      if (a.stance === 'chao' && a.model?.head) {
        const head = a.obj.worldToLocal(a.model.head.getWorldPosition(V1));
        a.label.position.set(head.x, head.y + 0.45, head.z);
      }
    }
    if (this.selected?.kind === 'character') {
      const a = this.actors.get(this.selected.id);
      if (a) this.selectionRing.position.set(a.obj.position.x, 0.015, a.obj.position.z);
    }
    if (this.hovered?.kind === 'character') {
      const a = this.actors.get(this.hovered.id);
      if (a) this.hoverRing.position.set(a.obj.position.x, 0.013, a.obj.position.z);
    }
    const view = new THREE.Vector2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z).normalize();
    for (const w of this.walls) {
      const goal = w.normal && w.normal.dot(view) > 0.3 ? 0.08 : 1;
      w.obj.scale.y += (goal - w.obj.scale.y) * Math.min(1, dt * 8);
    }
    for (const d of this.decor) d.obj.visible = d.wall.scale.y > 0.6;
    // A placa desce junto com a parede baixada, para ficar na saída e não flutuar sobre a sala.
    for (const s of this.signs.values()) s.position.y = 0.35 + 2.25 * (s.userData.wall as THREE.Object3D).scale.y;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
