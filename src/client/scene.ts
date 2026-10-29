import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { tileDef } from '../engine/layout';
import { lightSources } from '../engine/light';
import { typeChain } from '../engine/objects';
import { lifeStatId, perceptionOf, strangerLabel, visionOf } from '../engine/perception';
import type { Character, Fixture, Location, ObjectType, WorldState } from '../engine/types';
import { capitalize } from './format';
import { characterModel, fixtureModel, seatOffset, type CharacterModel, type Clip } from './models';
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
  wallPiece,
} from './props';

export interface Pick {
  kind: 'character' | 'fixture' | 'item';
  id: string;
}

interface Actor {
  obj: THREE.Group;
  label: CSS2DObject;
  target: THREE.Vector3;
  yaw: number;
  seated: boolean;
  /** Personagem animado do catálogo, quando já carregou (antes disso, o boneco primitivo). */
  model?: CharacterModel;
  clip?: Clip;
  /** O clipe atual toca uma vez (fala, aceno) e depois volta ao estado do ator. */
  once?: boolean;
}

interface WallPart {
  obj: THREE.Object3D;
  /** Normal para fora da sala, no plano XZ; a parede some quando fica entre a câmera e o interior. */
  normal: THREE.Vector2 | null;
}

const PLAYER_COLOR = '#f0b35a';

const EXIT_ICON: Partial<Record<Fixture['kind'], string>> = { door: '🚪', elevator: '🛗', stairs: '🪜' };

function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}

function tagPick(obj: THREE.Object3D, pick: Pick): void {
  obj.traverse((o) => (o.userData.pick = pick));
}

/**
 * Visão 3D do estado: uma função do mundo, que nunca guarda estado próprio
 * além de animações. O grid (x, y) vira o plano (x, z).
 */
export class WorldView {
  onPick: (pick: Pick | null) => void = () => {};

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
  private shown: { world: WorldState; loc: Location } | null = null;
  private selected: Pick | null = null;
  private selectionRing = playerRing('#ffffff');
  private selectionBox: THREE.BoxHelper | null = null;
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

    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => (this.pressed = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - this.pressed.x, e.clientY - this.pressed.y) > 5) return;
      this.select(this.pickAt(e));
    });
    canvas.addEventListener('pointermove', (e) => {
      canvas.style.cursor = this.pickAt(e) ? 'pointer' : 'grab';
    });
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
  }

  clear(): void {
    this.select(null);
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
        if (!actor.seated) this.play(actor, 'talk', true);
      }
      balloon.element.dataset.age = String(age);
      balloon.element.dataset.mode = line.mode ?? 'fala';
      // Falas mais antigas sobem: vizinhos que falam em sequência não se sobrepõem.
      balloon.position.set(0, (actor.seated ? 1.86 : 2.24) + age * 0.5, 0);
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

  private pickAt(e: PointerEvent): Pick | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.room.children, true).find((h) => h.object.userData.pick);
    return (hit?.object.userData.pick as Pick | undefined) ?? null;
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
    this.room.add(floor);

    for (const f of loc.fixtures) {
      const chain = typeChain(world, f.kind);
      const obj = buildFixture(f, chain);
      obj.name = `fixture:${f.id}`;
      tagPick(obj, { kind: 'fixture', id: f.id });
      this.room.add(obj);
      void this.upgradeFixture(obj, f, chain);
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
    this.frame(loc);
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
    this.play(actor, actor.seated ? 'sit' : 'idle');
  }

  /** Troca o clipe com uma transição curta; `once` toca uma vez e devolve ao estado do ator. */
  private play(actor: Actor, clip: Clip, once = false): void {
    const next = actor.model?.actions[clip];
    if (!actor.model || !next || (actor.clip === clip && !once)) return;
    const previous = actor.clip ? actor.model.actions[actor.clip] : undefined;
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.fadeIn(0.25).play();
    if (previous && previous !== next) previous.fadeOut(0.25);
    actor.clip = clip;
    actor.once = once;
  }

  /** Troca as primitivas do móvel pelo modelo do catálogo, quando ele carrega e se houver. */
  private async upgradeFixture(obj: THREE.Group, f: Fixture, chain: ObjectType[]): Promise<void> {
    const room = this.room;
    const model = await fixtureModel(f, chain);
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
    const kinds = typeChain(world, seat.kind).map((t) => t.id);
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
    return { pos, yaw, seated: !typeChain(world, seat.kind).some((t) => t.bed) };
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
        actor = { obj, label, target: pos.clone(), yaw, seated: false };
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
      actor.target.copy(pos);
      actor.yaw = yaw;
      if (actor.seated !== seated) setSeated(actor.obj, seated);
      actor.seated = seated;
      actor.label.position.set(0, seated ? 1.62 : 2.0, 0);
    }
    for (const [id, actor] of this.actors) {
      if (present.has(id)) continue;
      this.removeBalloon(id);
      actor.label.element.remove();
      this.room.remove(actor.obj);
      this.actors.delete(id);
    }
  }

  private syncItems(world: WorldState, loc: Location): void {
    const present = new Set<string>();
    for (const item of Object.values(world.items)) {
      const h = item.holder;
      let pos: THREE.Vector3 | null = null;
      if (h.kind === 'ground' && h.locationId === loc.id) pos = new THREE.Vector3(h.x, 0.01, h.y);
      if (h.kind === 'fixture') {
        const f = loc.fixtures.find((fx) => fx.id === h.id);
        if (f) {
          const s = hash(item.id);
          const surface = typeChain(world, f.kind).map((t) => t.surface).find((v) => v !== undefined);
          pos = new THREE.Vector3(f.x + (f.w - 1) / 2 + ((s % 40) - 20) / 100, this.surfaces.get(f.id) ?? surface ?? 0.8, f.y + (f.h - 1) / 2 + (((s >>> 8) % 30) - 15) / 100);
          if (f.kind === 'desk') {
            const yaw = YAW[f.facing];
            pos.add(new THREE.Vector3(0.16 * Math.sin(yaw), 0, 0.16 * Math.cos(yaw)));
          }
          if (f.kind === 'board') {
            const [dx, dz] = DIR_VEC[f.facing];
            pos.set(f.x + (f.w - 1) / 2 + ((s % 60) - 30) / 100, surface ?? 0.97, f.y + (f.h - 1) / 2).add(new THREE.Vector3(dx * 0.58, 0, dz * 0.58));
          }
        }
      }
      if (!pos) continue;
      present.add(item.id);
      let obj = this.items.get(item.id);
      if (!obj) {
        obj = buildItem(item);
        tagPick(obj, { kind: 'item', id: item.id });
        this.room.add(obj);
        this.items.set(item.id, obj);
      }
      obj.position.copy(pos);
    }
    for (const [id, obj] of this.items) {
      if (present.has(id)) continue;
      this.room.remove(obj);
      this.items.delete(id);
    }
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
    for (const a of this.actors.values()) {
      if (a.model) {
        a.model.mixer.update(dt);
        // Sentado, andando ou parado; um gesto de fala termina antes de voltar ao estado.
        const state: Clip = a.seated ? 'sit' : a.obj.position.distanceTo(a.target) > 0.06 ? 'walk' : 'idle';
        const gesturing = a.once && a.clip && a.model.actions[a.clip]?.isRunning() && state === 'idle';
        if (!gesturing && a.clip !== state) this.play(a, state);
      }
      a.obj.position.lerp(a.target, 1 - Math.exp(-dt * 5));
      a.obj.rotation.y = lerpAngle(a.obj.rotation.y, a.yaw, 1 - Math.exp(-dt * 8));
      if (a.obj.scale.x < 1) a.obj.scale.setScalar(Math.min(1, a.obj.scale.x + dt * 3));
    }
    if (this.selected?.kind === 'character') {
      const a = this.actors.get(this.selected.id);
      if (a) this.selectionRing.position.set(a.obj.position.x, 0.015, a.obj.position.z);
    }
    const view = new THREE.Vector2(this.camera.position.x - this.controls.target.x, this.camera.position.z - this.controls.target.z).normalize();
    for (const w of this.walls) {
      const goal = w.normal && w.normal.dot(view) > 0.3 ? 0.08 : 1;
      w.obj.scale.y += (goal - w.obj.scale.y) * Math.min(1, dt * 8);
    }
    // A placa desce junto com a parede baixada, para ficar na saída e não flutuar sobre a sala.
    for (const s of this.signs.values()) s.position.y = 0.35 + 2.25 * (s.userData.wall as THREE.Object3D).scale.y;
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
