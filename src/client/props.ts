import * as THREE from 'three';
import type { Character, Dir, Fixture, FloorStyle, Item } from '../engine/types';

/** Modelos low-poly feitos de primitivas. Espaço do modelo: centro no chão, frente para +Z. */
export const WALL_H = 2.4;
export const YAW: Record<Dir, number> = { S: 0, E: Math.PI / 2, N: Math.PI, W: -Math.PI / 2 };
export const DIR_VEC: Record<Dir, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };

/** Altura da superfície onde itens ficam apoiados, por tipo de móvel. */
export const SURFACE_Y: Partial<Record<Fixture['kind'], number>> = {
  desk: 0.76,
  teacher_desk: 0.81,
  table: 0.79,
  counter: 1.05,
  shelf: 1.02,
  crate: 0.62,
  bed: 0.52,
  sofa: 0.44,
  chair: 0.48,
  locker: 1.92,
  board: 0.97,
};

const materials = new Map<string, THREE.MeshStandardMaterial>();

export function mat(color: THREE.ColorRepresentation, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${JSON.stringify(opts)}`;
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0, ...opts });
    materials.set(key, m);
  }
  return m;
}

function mesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0, opts?: THREE.MeshStandardMaterialParameters): THREE.Mesh {
  const m = new THREE.Mesh(geometry, mat(color, opts));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function box(w: number, h: number, d: number, color: THREE.ColorRepresentation, x = 0, y = 0, z = 0): THREE.Mesh {
  return mesh(new THREE.BoxGeometry(w, h, d), color, x, y, z);
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = <T>(list: readonly T[], seed: number, salt = 0): T => list[(seed >>> salt) % list.length];

// ------------------------------------------------------------------ chão e paredes

const FLOOR: Record<FloorStyle, [string, string]> = {
  wood: ['#b7875a', '#a97b50'],
  tile: ['#d9d4c7', '#c8c2b3'],
  stone: ['#8d8a84', '#7f7c76'],
  carpet: ['#7b5a6b', '#755566'],
  grass: ['#6d9a4f', '#638f47'],
  dirt: ['#8a6a4a', '#7f6044'],
};

export function floorColor(style: FloorStyle, x: number, y: number): THREE.Color {
  const [a, b] = FLOOR[style] ?? FLOOR.wood;
  const alt = style === 'wood' ? (x + (y % 2 ? 1 : 0)) % 3 === 0 : (x + y) % 2 === 0;
  const c = new THREE.Color(alt ? b : a);
  const jitter = ((hash(`${x},${y}`) % 100) / 100 - 0.5) * 0.04;
  return c.offsetHSL(0, 0, jitter);
}

export const WALL_COLOR = '#e4dccd';
const TRIM = '#8e7356';

export function wallPiece(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(1, WALL_H, 1, WALL_COLOR, 0, WALL_H / 2, 0));
  g.add(box(1.002, 0.14, 1.002, TRIM, 0, 0.07, 0));
  return g;
}

// ------------------------------------------------------------------ móveis

const WOOD = '#c8955c';
const DARK_WOOD = '#7b5636';
const METAL = '#5b6472';

function chairAt(g: THREE.Group, x: number, z: number, color = '#b07a46'): void {
  const c = new THREE.Group();
  c.add(box(0.4, 0.04, 0.38, color, 0, 0.45, 0));
  c.add(box(0.4, 0.34, 0.04, color, 0, 0.68, -0.18));
  for (const [lx, lz] of [[-0.17, -0.16], [0.17, -0.16], [-0.17, 0.16], [0.17, 0.16]]) c.add(box(0.03, 0.45, 0.03, METAL, lx, 0.225, lz));
  c.position.set(x, 0, z);
  g.add(c);
}

function legs(g: THREE.Group, w: number, d: number, h: number, color = METAL): void {
  const x = w / 2 - 0.05;
  const z = d / 2 - 0.05;
  for (const [lx, lz] of [[-x, -z], [x, -z], [-x, z], [x, z]]) g.add(box(0.05, h, 0.05, color, lx, h / 2, lz));
}

function desk(g: THREE.Group): void {
  const top = new THREE.Group();
  top.add(box(0.64, 0.04, 0.44, WOOD, 0, 0.74, 0));
  top.add(box(0.56, 0.1, 0.36, '#9b7148', 0, 0.66, 0.01));
  legs(top, 0.6, 0.4, 0.62);
  top.position.z = 0.16;
  g.add(top);
  chairAt(g, 0, -0.3);
}

function teacherDesk(g: THREE.Group, w: number, d: number): void {
  const width = w * 0.94;
  const depth = Math.min(d, 1) * 0.72;
  g.add(box(width, 0.05, depth, DARK_WOOD, 0, 0.785, 0));
  g.add(box(width - 0.06, 0.7, 0.04, '#6a4a2f', 0, 0.41, depth / 2 - 0.04));
  for (const side of [-1, 1]) g.add(box(0.05, 0.76, depth - 0.04, '#6a4a2f', side * (width / 2 - 0.03), 0.38, 0));
  g.add(box(0.4, 0.5, depth - 0.1, '#5e4129', width / 2 - 0.3, 0.3, 0));
  chairAt(g, -width / 4, -depth / 2 - 0.35, '#3d4250');
}

function table(g: THREE.Group, w: number, d: number): void {
  g.add(box(w * 0.92, 0.05, d * 0.9, WOOD, 0, 0.765, 0));
  legs(g, w * 0.88, d * 0.86, 0.74, DARK_WOOD);
}

function shelf(g: THREE.Group, w: number, seed: number): void {
  const width = w * 0.94;
  g.add(box(width, 1.8, 0.06, DARK_WOOD, 0, 0.9, -0.42));
  for (const side of [-1, 1]) g.add(box(0.05, 1.8, 0.38, DARK_WOOD, side * (width / 2 - 0.025), 0.9, -0.26));
  const books = ['#b5523c', '#3f6db3', '#d39a3a', '#4f8f6a', '#8a5aa8', '#e2d6bf', '#2f8f9d'];
  for (let level = 0; level < 4; level++) {
    const y = 0.08 + level * 0.46;
    g.add(box(width - 0.06, 0.04, 0.36, DARK_WOOD, 0, y, -0.26));
    let x = -width / 2 + 0.08;
    for (let i = 0; x < width / 2 - 0.12; i++) {
      const bw = 0.05 + ((seed >>> ((i + level) % 20)) % 4) * 0.015;
      const bh = 0.24 + ((seed >>> ((i * 3 + level) % 24)) % 5) * 0.03;
      g.add(box(bw, bh, 0.26, pick(books, seed, (i * 7 + level * 3) % 24), x + bw / 2, y + 0.02 + bh / 2, -0.27));
      x += bw + 0.012;
    }
  }
}

function locker(g: THREE.Group): void {
  g.add(box(0.86, 1.9, 0.5, '#6f8fa8', 0, 0.95, -0.22));
  g.add(box(0.012, 1.8, 0.01, '#4c6476', 0, 0.95, 0.035));
  for (const side of [-1, 1]) g.add(box(0.03, 0.14, 0.03, '#d9dde3', side * 0.07, 1.0, 0.045));
}

function plant(g: THREE.Group, seed: number): void {
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.32, 7), '#b5623c', 0, 0.16, 0));
  g.add(mesh(new THREE.IcosahedronGeometry(0.36, 0), pick(['#4f8f4a', '#5e9e52', '#3f7d45'], seed), 0, 0.72, 0));
  g.add(mesh(new THREE.IcosahedronGeometry(0.24, 0), '#6aab5c', 0.12, 1.0, 0.05));
}

function bed(g: THREE.Group, w: number, d: number, seed: number): void {
  g.add(box(w * 0.92, 0.28, d * 0.96, DARK_WOOD, 0, 0.14, 0));
  g.add(box(w * 0.88, 0.14, d * 0.92, '#efe9df', 0, 0.35, 0));
  g.add(box(w * 0.89, 0.06, d * 0.6, pick(['#5b7fb3', '#b35b6a', '#6a9a6a', '#c9a24a'], seed), 0, 0.44, d * 0.16));
  g.add(box(w * 0.6, 0.1, 0.28, '#ffffff', 0, 0.47, -d * 0.36));
  g.add(box(w * 0.92, 0.6, 0.06, DARK_WOOD, 0, 0.3, -d * 0.48));
}

function sofa(g: THREE.Group, w: number, seed: number): void {
  const color = pick(['#7b5a6b', '#4f6d8f', '#8f6a4f', '#5f7f5a'], seed);
  const width = w * 0.95;
  g.add(box(width, 0.4, 0.78, color, 0, 0.2, -0.04));
  g.add(box(width, 0.5, 0.2, color, 0, 0.6, -0.38));
  for (const side of [-1, 1]) g.add(box(0.16, 0.56, 0.78, color, side * (width / 2 - 0.08), 0.28, -0.04));
}

function counter(g: THREE.Group, w: number, d: number): void {
  g.add(box(w * 0.98, 0.98, d * 0.88, '#9a7a5a', 0, 0.49, 0));
  g.add(box(w, 0.06, d * 0.92, '#d9d0c2', 0, 1.01, 0));
}

function crate(g: THREE.Group): void {
  g.add(box(0.6, 0.58, 0.6, '#b08b5a', 0, 0.29, 0));
  for (const y of [0.08, 0.5]) g.add(box(0.62, 0.06, 0.62, '#8a6a42', 0, y, 0));
}

/** Quadro-negro na parede: inclui o pedaço de parede. A superfície recebe a textura do texto. */
function board(g: THREE.Group, length: number): void {
  g.add(...wallPiece().children.map((c) => c.clone()));
  if (length > 1) g.children.forEach((c) => (c.scale.x = length));
  g.add(box(length * 0.92, 1.08, 0.05, '#6a4a2f', 0, 1.45, 0.52));
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(length * 0.86, 0.96), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.95 }));
  surface.position.set(0, 1.45, 0.548);
  surface.name = 'board-surface';
  g.add(surface);
  g.add(box(length * 0.86, 0.04, 0.1, '#6a4a2f', 0, 0.93, 0.58));
}

function windowPiece(g: THREE.Group, length: number): void {
  g.add(box(length, 0.9, 1, WALL_COLOR, 0, 0.45, 0));
  g.add(box(length, WALL_H - 2.1, 1, WALL_COLOR, 0, (2.1 + WALL_H) / 2, 0));
  g.add(box(length * 1.002, 0.14, 1.002, TRIM, 0, 0.07, 0));
  g.add(mesh(new THREE.BoxGeometry(length * 0.96, 1.2, 0.04), '#bfe3f2', 0, 1.5, 0, { transparent: true, opacity: 0.35, roughness: 0.1 }));
  g.add(box(length, 0.06, 0.16, '#f2efe8', 0, 0.92, 0.42));
  for (let i = 0; i <= Math.max(1, Math.round(length)); i++) {
    const x = -length / 2 + (i * length) / Math.max(1, Math.round(length));
    g.add(box(0.05, 1.2, 0.08, '#f2efe8', Math.max(-length / 2 + 0.025, Math.min(length / 2 - 0.025, x)), 1.5, 0));
  }
}

function door(g: THREE.Group, length: number): void {
  g.add(box(length, WALL_H - 2.1, 1, WALL_COLOR, 0, (2.1 + WALL_H) / 2, 0));
  for (const side of [-1, 1]) g.add(box(0.08, 2.1, 1, '#8e7356', side * (length / 2 - 0.04), 1.05, 0));
  const hinge = new THREE.Group();
  hinge.position.set(-length / 2 + 0.08, 0, 0.45);
  const panel = box(length - 0.18, 2.0, 0.05, '#9b6b43', (length - 0.18) / 2, 1.0, 0);
  hinge.add(panel, box(0.04, 0.04, 0.12, '#d9c27a', length - 0.3, 1.0, 0.04));
  hinge.rotation.y = -1.15;
  g.add(hinge);
}

export function buildFixture(f: Fixture): THREE.Group {
  const alongX = f.facing === 'N' || f.facing === 'S';
  const w = alongX ? f.w : f.h;
  const d = alongX ? f.h : f.w;
  const seed = hash(f.id);
  const g = new THREE.Group();
  switch (f.kind) {
    case 'desk':
      desk(g);
      break;
    case 'teacher_desk':
      teacherDesk(g, w, d);
      break;
    case 'chair':
      chairAt(g, 0, 0);
      break;
    case 'table':
      table(g, w, d);
      break;
    case 'shelf':
      shelf(g, w, seed);
      break;
    case 'locker':
      locker(g);
      break;
    case 'plant':
      plant(g, seed);
      break;
    case 'bed':
      bed(g, w, d, seed);
      break;
    case 'sofa':
      sofa(g, w, seed);
      break;
    case 'counter':
      counter(g, w, d);
      break;
    case 'crate':
      crate(g);
      break;
    case 'board':
      board(g, w);
      break;
    case 'window':
      windowPiece(g, w);
      break;
    case 'door':
      door(g, w);
      break;
  }
  g.position.set(f.x + (f.w - 1) / 2, 0, f.y + (f.h - 1) / 2);
  g.rotation.y = YAW[f.facing];
  return g;
}

/** Texto do quadro em giz, numa textura de canvas. */
export function drawBoard(text: string, length: number): THREE.CanvasTexture {
  const width = 1024;
  const height = Math.round(width * (0.96 / (length * 0.86)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#2e4d3d';
  ctx.fillRect(0, 0, width, height);
  for (let i = 0; i < 18; i++) {
    const s = hash(`${text}${i}`);
    ctx.fillStyle = `rgba(255,255,255,${0.015 + (s % 20) / 1000})`;
    ctx.beginPath();
    ctx.ellipse(s % width, (s >>> 8) % height, 60 + (s % 140), 20 + (s % 50), (s % 314) / 100, 0, Math.PI * 2);
    ctx.fill();
  }
  if (text.trim()) {
    const pad = width * 0.05;
    const font = (size: number) => `${size}px "Chalkboard SE", "Comic Sans MS", "Segoe Print", cursive`;
    const wrap = (size: number): string[] => {
      ctx.font = font(size);
      const lines: string[] = [];
      for (const para of text.split('\n')) {
        let line = '';
        for (const word of para.split(/\s+/)) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > width - pad * 2 && line) {
            lines.push(line);
            line = word;
          } else line = next;
        }
        lines.push(line);
      }
      return lines;
    };
    let size = Math.round(height / 4.5);
    let lines = wrap(size);
    while (size > 18 && lines.length * size * 1.25 > height - pad * 2) lines = wrap((size -= 4));
    ctx.fillStyle = 'rgba(244,241,232,0.92)';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => ctx.fillText(line, pad, pad + i * size * 1.25));
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

// ------------------------------------------------------------------ personagens e itens

const SKIN = ['#f1d3b5', '#e2b48c', '#c98e62', '#9c6644', '#6b4430'];
const HAIR = ['#1f1a17', '#2e231c', '#3b2a20', '#6a4a2f', '#a8743c', '#d6b36a', '#b54a32', '#5a5f6b'];
const SHIRT = ['#3f6db3', '#c2553f', '#4f8f6a', '#8a5aa8', '#d39a3a', '#4a4f5c', '#2f8f9d', '#b0476a'];
const PANTS = ['#2b3040', '#4b3a2a', '#2f4a5f', '#3d3d3d', '#5a4a6a'];

function paletteFor(c: Character) {
  const h = hash(c.id);
  const student = /alun|estudante|student|colegial/i.test(c.role);
  return {
    skin: pick(SKIN, h, 3),
    hair: pick(HAIR, h, 7),
    shirt: student ? '#f3f1ea' : pick(SHIRT, h, 11),
    pants: student ? '#26304a' : pick(PANTS, h, 15),
    accent: student ? '#b5523c' : null,
  };
}

/** Boneco low-poly. `userData.hips` e `userData.knees` permitem sentar; `userData.body` sobe e desce. */
export function buildCharacter(c: Character): THREE.Group {
  const p = paletteFor(c);
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const hips: THREE.Group[] = [];
  const knees: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.09, 0.8, 0);
    hip.add(box(0.13, 0.42, 0.15, p.pants, 0, -0.2, 0));
    const knee = new THREE.Group();
    knee.position.y = -0.4;
    knee.add(box(0.12, 0.4, 0.14, p.pants, 0, -0.2, 0));
    knee.add(box(0.13, 0.07, 0.22, '#2a2622', 0, -0.37, 0.04));
    hip.add(knee);
    body.add(hip);
    hips.push(hip);
    knees.push(knee);
  }
  body.add(mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.62, 7), p.shirt, 0, 1.1, 0));
  if (p.accent) body.add(box(0.07, 0.22, 0.03, p.accent, 0, 1.24, 0.205));
  for (const side of [-1, 1]) {
    body.add(box(0.09, 0.54, 0.11, p.shirt, side * 0.285, 1.1, 0));
    body.add(box(0.08, 0.08, 0.09, p.skin, side * 0.285, 0.8, 0));
  }
  body.add(mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.08, 6), p.skin, 0, 1.44, 0));
  body.add(mesh(new THREE.IcosahedronGeometry(0.17, 1), p.skin, 0, 1.6, 0));
  body.add(mesh(new THREE.SphereGeometry(0.182, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.52), p.hair, 0, 1.615, -0.012));
  for (const side of [-1, 1]) body.add(box(0.035, 0.04, 0.02, '#1d1b1a', side * 0.06, 1.6, 0.158));
  g.userData = { body, hips, knees };
  return g;
}

export function setSeated(character: THREE.Group, seated: boolean): void {
  const { body, hips, knees } = character.userData as { body: THREE.Group; hips: THREE.Group[]; knees: THREE.Group[] };
  body.position.y = seated ? 0.47 - 0.8 : 0;
  body.position.z = seated ? -0.06 : 0;
  hips.forEach((h) => (h.rotation.x = seated ? -Math.PI / 2 : 0));
  knees.forEach((k) => (k.rotation.x = seated ? Math.PI / 2 : 0));
}

export function buildItem(item: Item): THREE.Group {
  const g = new THREE.Group();
  const color = pick(['#e9e4d8', '#d39a3a', '#3f6db3', '#c2553f', '#4f8f6a', '#8a5aa8'], hash(item.id));
  g.add(box(0.2, 0.08, 0.14, color, 0, 0.04, 0));
  return g;
}

export function playerRing(color: string): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.38, 28), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  return ring;
}
