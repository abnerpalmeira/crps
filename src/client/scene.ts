import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { tileDef } from '../engine/layout';
import type { Character, Location, WorldState } from '../engine/types';
import {
  DIR_VEC,
  SURFACE_Y,
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
}

interface WallPart {
  obj: THREE.Object3D;
  /** Normal para fora da sala, no plano XZ; a parede some quando fica entre a câmera e o interior. */
  normal: THREE.Vector2 | null;
}

const PLAYER_COLOR = '#f0b35a';

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
  private readonly raycaster = new THREE.Raycaster();
  private readonly clock = new THREE.Clock();
  private room = new THREE.Group();
  private walls: WallPart[] = [];
  private actors = new Map<string, Actor>();
  private items = new Map<string, THREE.Object3D>();
  private boards = new Map<string, { surface: THREE.Mesh; text: string; length: number }>();
  private roomKey = '';
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
    this.labels.domElement.className = 'labels';
    host.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.32;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 70;
    this.controls.screenSpacePanning = false;

    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#6b5a48', 1.5));
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
      this.buildRoom(loc);
      this.roomKey = key;
    }
    if (!loc) return;
    this.syncBoards(loc);
    this.syncActors(world, loc);
    this.syncItems(world, loc);
    if (this.selected && !this.exists(this.selected)) this.select(null);
  }

  clear(): void {
    this.select(null);
    this.buildRoom(null);
    this.roomKey = '';
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
    for (const a of this.actors.values()) a.label.element.remove();
    this.actors.clear();
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

  private buildRoom(loc: Location | null): void {
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
      const obj = buildFixture(f);
      obj.name = `fixture:${f.id}`;
      tagPick(obj, { kind: 'fixture', id: f.id });
      this.room.add(obj);
      if (f.wall) {
        const [dx, dy] = DIR_VEC[f.facing];
        this.walls.push({ obj, normal: new THREE.Vector2(-dx, -dy) });
      }
      if (f.kind === 'board') {
        const surface = obj.getObjectByName('board-surface') as THREE.Mesh;
        this.boards.set(f.id, { surface, text: '\u0000', length: f.facing === 'N' || f.facing === 'S' ? f.w : f.h });
      }
    }
    this.frame(loc);
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

  private placement(c: Character, loc: Location): { pos: THREE.Vector3; yaw: number; seated: boolean } {
    const pos = new THREE.Vector3(c.pos!.x, 0, c.pos!.y);
    const seat = c.seatId ? loc.fixtures.find((f) => f.id === c.seatId) : undefined;
    if (!seat) return { pos, yaw: YAW[c.facing], seated: false };
    const yaw = YAW[seat.facing];
    const back = seat.kind === 'desk' ? -0.3 : seat.kind === 'sofa' ? -0.1 : 0;
    pos.add(new THREE.Vector3(back * Math.sin(yaw), 0, back * Math.cos(yaw)));
    return { pos, yaw, seated: seat.kind !== 'bed' };
  }

  private syncActors(world: WorldState, loc: Location): void {
    const present = new Set<string>();
    for (const c of Object.values(world.characters)) {
      if (c.locationId !== loc.id || !c.pos) continue;
      present.add(c.id);
      const { pos, yaw, seated } = this.placement(c, loc);
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
      }
      actor.label.element.textContent = c.isPlayer ? `${c.name} (você)` : c.name.split(' ')[0];
      actor.target.copy(pos);
      actor.yaw = yaw;
      if (actor.seated !== seated) setSeated(actor.obj, seated);
      actor.seated = seated;
      actor.label.position.set(0, seated ? 1.62 : 2.0, 0);
    }
    for (const [id, actor] of this.actors) {
      if (present.has(id)) continue;
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
          pos = new THREE.Vector3(f.x + (f.w - 1) / 2 + ((s % 40) - 20) / 100, SURFACE_Y[f.kind] ?? 0.8, f.y + (f.h - 1) / 2 + (((s >>> 8) % 30) - 15) / 100);
          if (f.kind === 'desk') {
            const yaw = YAW[f.facing];
            pos.add(new THREE.Vector3(0.16 * Math.sin(yaw), 0, 0.16 * Math.cos(yaw)));
          }
          if (f.kind === 'board') {
            const [dx, dz] = DIR_VEC[f.facing];
            pos.set(f.x + (f.w - 1) / 2 + ((s % 60) - 30) / 100, SURFACE_Y.board!, f.y + (f.h - 1) / 2).add(new THREE.Vector3(dx * 0.58, 0, dz * 0.58));
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

  private tick(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.controls.update();
    for (const a of this.actors.values()) {
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
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
