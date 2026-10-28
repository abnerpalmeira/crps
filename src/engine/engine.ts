import { MAX_FRAMES, snapshotScene } from './frames';
import { buildLocation, fixtureAt, isPassable, rectCenter, tileDef, type LocationSpec } from './layout';
import { parseDice, pickMany, randInt, rollDice } from './rng';
import { chebyshev, dirTowards, fold, formatClock, parseHHMM, slugify } from './text';
import type {
  Character,
  Clock,
  Dir,
  DifficultyName,
  Fact,
  Fixture,
  Item,
  ItemHolder,
  Location,
  LogKind,
  Pos,
  Ruleset,
  Thread,
  ThreadStatus,
  WorldState,
} from './types';

/** Erro de regra do mundo: a mensagem volta para o modelo como resultado da tool. */
export class EngineError extends Error {}

export const STAT_MIN = 0;
export const STAT_MAX = 5;

export const DEFAULT_RULESET: Ruleset = {
  name: 'Sistema Universal CRPS',
  attributes: [
    { id: 'corpo', name: 'Corpo', description: 'força, resistência e agilidade' },
    { id: 'mente', name: 'Mente', description: 'raciocínio, memória e percepção' },
    { id: 'presenca', name: 'Presença', description: 'carisma, empatia e autocontrole' },
  ],
  resources: [{ id: 'energia', name: 'Energia', max: 10, description: 'disposição física e mental' }],
  dice: '2d6',
  difficulties: { facil: 7, normal: 9, dificil: 11, muito_dificil: 13 },
  notes: 'Atributos e perícias vão de 0 a 5 (1 = mediano, 3 = muito bom, 5 = lendário).',
};

export const DIFFICULTY_LABEL: Record<DifficultyName, string> = {
  facil: 'fácil',
  normal: 'normal',
  dificil: 'difícil',
  muito_dificil: 'muito difícil',
};

const REACH = 2;
const THROW_REACH = 8;
const PLAYER_ALIASES = new Set(['player', 'jogador', 'jogadora', 'voce', 'eu', 'protagonista']);
const DIR_ALIASES: Record<string, Dir> = {
  n: 'N', norte: 'N', s: 'S', sul: 'S', e: 'E', l: 'E', leste: 'E', w: 'W', o: 'W', oeste: 'W',
};

export interface Placement {
  x?: number;
  y?: number;
  /** Id de um assento ou "random" para sortear um assento livre. */
  seat?: string;
  /** Id de um móvel ou personagem: fica no tile livre mais próximo dele. */
  near?: string;
}

export interface HolderRef {
  character_id?: string;
  fixture_id?: string;
  location_id?: string;
  x?: number;
  y?: number;
}

export interface CharacterInput {
  id?: string;
  name: string;
  role: string;
  appearance: string;
  traits?: string[];
  is_player?: boolean;
  attributes?: Record<string, number>;
  skills?: Record<string, number>;
  resources?: Record<string, number>;
  personality?: string;
  background?: string;
  goals?: string;
  location_id?: string;
  position?: Placement;
  offscreen?: boolean;
  facing?: string;
}

export interface CharacterUpdate {
  character_id: string;
  name?: string;
  role?: string;
  appearance?: string;
  traits_add?: string[];
  traits_remove?: string[];
  personality?: string;
  background?: string;
  goals?: string;
  attributes?: Record<string, number>;
  skills?: Record<string, number>;
  resource_deltas?: Record<string, number>;
  resources_set?: Record<string, number>;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectGap(a: Rect, b: Rect): number {
  const gx = Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1));
  const gy = Math.max(0, a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1));
  return Math.max(gx, gy);
}

export type RandomResult =
  | { mode: 'dice'; dice: string; rolls: number[]; total: number }
  | { mode: 'pick'; picked: string[] }
  | { mode: 'range'; min: number; max: number; value: number };

const pointRect = (p: Pos): Rect => ({ x: p.x, y: p.y, w: 1, h: 1 });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class GameEngine {
  constructor(public state: WorldState) {}

  static create(premise: string, seed = Math.floor(Math.random() * 2 ** 31)): GameEngine {
    return new GameEngine({
      version: 1,
      id: `w${seed.toString(36)}`,
      premise,
      createdAt: new Date().toISOString(),
      seed,
      rng: seed,
      turn: 0,
      clock: { day: 1, minutes: 8 * 60 },
      ruleset: structuredClone(DEFAULT_RULESET),
      playerId: null,
      locations: {},
      characters: {},
      items: {},
      facts: [],
      threads: {},
      log: [],
      frames: [],
      counters: {},
    });
  }

  static fromJSON(json: string): GameEngine {
    const state = JSON.parse(json) as WorldState;
    if (state.version !== 1) throw new Error(`Versão de save não suportada: ${String(state.version)}`);
    state.frames ??= []; // saves de antes do replay
    return new GameEngine(state);
  }

  toJSON(): string {
    return JSON.stringify(this.state);
  }

  /** Cópia para o cliente, com histórico e retratos encurtados. */
  snapshot(maxLog = 200, maxFrames = 80): WorldState {
    const copy = structuredClone(this.state);
    copy.log = copy.log.slice(-maxLog);
    copy.frames = copy.frames.slice(-maxFrames);
    return copy;
  }

  /** Guarda o retrato da cena do turno atual, para o replay. */
  recordFrame(): void {
    const frame = snapshotScene(this.state);
    this.state.frames = [...this.state.frames.filter((f) => f.turn !== frame.turn), frame].slice(-MAX_FRAMES);
  }

  // ---------------------------------------------------------------- consultas

  get player(): Character | null {
    return this.state.playerId ? (this.state.characters[this.state.playerId] ?? null) : null;
  }

  get currentLocation(): Location | null {
    const id = this.player?.locationId ?? this.lastLocationId();
    return id ? this.state.locations[id] : null;
  }

  private lastLocationId(): string | null {
    const ids = Object.keys(this.state.locations);
    return ids.length ? ids[ids.length - 1] : null;
  }

  private isTaken(id: string): boolean {
    const s = this.state;
    return Boolean(s.characters[id] || s.items[id] || s.locations[id] || s.threads[id]);
  }

  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.isTaken(id); n++) id = `${base}_${n}`;
    return id;
  }

  private claimId(explicit: string | undefined, fallback: string, what: string): string {
    if (explicit) {
      const id = slugify(explicit);
      if (this.isTaken(id)) throw new EngineError(`Já existe algo com o id "${id}". Escolha outro id para ${what}.`);
      return id;
    }
    return this.uniqueId(slugify(fallback, 24));
  }

  private nextCounter(key: string): number {
    this.state.counters[key] = (this.state.counters[key] ?? 0) + 1;
    return this.state.counters[key];
  }

  private listCharacters(): string {
    const all = Object.values(this.state.characters);
    if (!all.length) return 'nenhum';
    return all.slice(0, 25).map((c) => `${c.id} (${c.name})`).join(', ') + (all.length > 25 ? ', …' : '');
  }

  findCharacter(ref: string): Character {
    const s = this.state;
    const direct = s.characters[ref] ?? s.characters[slugify(ref)];
    if (direct) return direct;
    const f = fold(ref);
    if (PLAYER_ALIASES.has(f) && this.player) return this.player;
    const all = Object.values(s.characters);
    const exact = all.filter((c) => fold(c.name) === f);
    const matches = exact.length ? exact : all.filter((c) => fold(c.name).split(/\s+/)[0] === f);
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new EngineError(`"${ref}" é ambíguo: ${matches.map((c) => `${c.id} (${c.name})`).join(', ')}.`);
    }
    throw new EngineError(`Personagem "${ref}" não existe. Personagens: ${this.listCharacters()}.`);
  }

  findLocation(ref: string): Location {
    const s = this.state;
    const direct = s.locations[ref] ?? s.locations[slugify(ref)];
    if (direct) return direct;
    const match = Object.values(s.locations).filter((l) => fold(l.name) === fold(ref));
    if (match.length === 1) return match[0];
    const known = Object.values(s.locations).map((l) => `${l.id} (${l.name})`).join(', ') || 'nenhum';
    throw new EngineError(`Local "${ref}" não existe. Locais: ${known}.`);
  }

  findFixture(ref: string, preferLocationId?: string | null): Fixture {
    const locs = Object.values(this.state.locations);
    const all = locs.flatMap((l) => l.fixtures);
    const direct = all.find((f) => f.id === ref);
    if (direct) return direct;
    const scope = preferLocationId ?? this.currentLocation?.id;
    const short = all.find((f) => f.locationId === scope && f.id === `${scope}/${ref}`);
    if (short) return short;
    const hint = scope ? ` Móveis em ${scope}: ${this.state.locations[scope]?.fixtures.map((f) => f.id).slice(0, 30).join(', ')}.` : '';
    throw new EngineError(`Móvel "${ref}" não existe.${hint}`);
  }

  findItem(ref: string): Item {
    const s = this.state;
    const direct = s.items[ref] ?? s.items[slugify(ref)];
    if (direct) return direct;
    const matches = Object.values(s.items).filter((i) => fold(i.name) === fold(ref));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new EngineError(`"${ref}" é ambíguo: ${matches.map((i) => `${i.id} (${this.describeHolder(i.holder)})`).join(', ')}.`);
    }
    const known = Object.values(s.items).slice(0, 25).map((i) => `${i.id} (${i.name})`).join(', ') || 'nenhum';
    throw new EngineError(`Item "${ref}" não existe. Itens: ${known}.`);
  }

  characterAt(locationId: string, x: number, y: number): Character | undefined {
    return Object.values(this.state.characters).find(
      (c) => c.locationId === locationId && c.pos?.x === x && c.pos?.y === y,
    );
  }

  charactersIn(locationId: string): Character[] {
    return Object.values(this.state.characters).filter((c) => c.locationId === locationId);
  }

  itemsHeldBy(characterId: string): Item[] {
    return Object.values(this.state.items).filter((i) => i.holder.kind === 'character' && i.holder.id === characterId);
  }

  itemsOn(fixtureId: string): Item[] {
    return Object.values(this.state.items).filter((i) => i.holder.kind === 'fixture' && i.holder.id === fixtureId);
  }

  itemsOnGround(locationId: string): Item[] {
    return Object.values(this.state.items).filter((i) => i.holder.kind === 'ground' && i.holder.locationId === locationId);
  }

  describeHolder(h: ItemHolder): string {
    if (h.kind === 'character') return `com ${this.state.characters[h.id]?.name ?? h.id}`;
    if (h.kind === 'fixture') return `em ${h.id}`;
    return `no chão de ${h.locationId} (${h.x},${h.y})`;
  }

  private freeTile(loc: Location, x: number, y: number, moverId: string | null): boolean {
    const who = this.characterAt(loc.id, x, y);
    return !who || who.id === moverId;
  }

  private freeSeatTile(f: Fixture, moverId: string | null): Pos | null {
    const loc = this.state.locations[f.locationId];
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) if (this.freeTile(loc, x, y, moverId)) return { x, y };
    }
    return null;
  }

  /** Busca em largura com 8 direções, sem cortar quinas (exceto ao entrar/sair de um assento). */
  findPath(loc: Location, from: Pos, to: Pos): Pos[] | null {
    const W = loc.width;
    const key = (x: number, y: number) => y * W + x;
    const goal = key(to.x, to.y);
    const prev = new Map<number, number>([[key(from.x, from.y), -1]]);
    const queue: Pos[] = [from];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      if (key(cur.x, cur.y) === goal) {
        const path: Pos[] = [];
        for (let k = goal; k !== -1; k = prev.get(k)!) path.unshift({ x: k % W, y: Math.floor(k / W) });
        return path;
      }
      const curPassable = isPassable(loc, cur.x, cur.y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= loc.width || ny >= loc.height || prev.has(key(nx, ny))) continue;
        const isGoal = key(nx, ny) === goal;
        const nextPassable = isPassable(loc, nx, ny);
        if (!isGoal && !nextPassable) continue;
        const seatStep = !curPassable || !nextPassable;
        if (dx && dy && !seatStep && !(isPassable(loc, cur.x + dx, cur.y) && isPassable(loc, cur.x, cur.y + dy))) continue;
        prev.set(key(nx, ny), key(cur.x, cur.y));
        queue.push({ x: nx, y: ny });
      }
    }
    return null;
  }

  private nearestFreeAround(loc: Location, target: Rect, from: Pos | null, moverId: string | null): Pos | null {
    const candidates: Pos[] = [];
    for (let y = target.y - 1; y <= target.y + target.h; y++) {
      for (let x = target.x - 1; x <= target.x + target.w; x++) {
        const inside = x >= target.x && x < target.x + target.w && y >= target.y && y < target.y + target.h;
        if (!inside && isPassable(loc, x, y) && this.freeTile(loc, x, y, moverId)) candidates.push({ x, y });
      }
    }
    if (!candidates.length) return null;
    if (from) {
      let best: { p: Pos; len: number } | null = null;
      for (const p of candidates) {
        const path = this.findPath(loc, from, p);
        if (path && (!best || path.length < best.len)) best = { p, len: path.length };
      }
      if (best) return best.p;
    }
    const c = rectCenter(target);
    return candidates.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
  }

  private nearestFreePassable(loc: Location, p: Pos): Pos | null {
    let best: Pos | null = null;
    for (let y = 0; y < loc.height; y++) {
      for (let x = 0; x < loc.width; x++) {
        if (!isPassable(loc, x, y) || !this.freeTile(loc, x, y, null)) continue;
        if (!best || chebyshev(p, { x, y }) < chebyshev(p, best)) best = { x, y };
      }
    }
    return best;
  }

  /** Retângulo ocupado por um móvel ou personagem (usado como alvo de "near"). */
  private rectOf(ref: string, loc: Location): Rect {
    try {
      const f = this.findFixture(ref, loc.id);
      if (f.locationId === loc.id) return f;
    } catch {
      // não é móvel; tenta personagem
    }
    const c = this.findCharacter(ref);
    if (c.locationId !== loc.id || !c.pos) throw new EngineError(`${c.name} não está em ${loc.name}.`);
    return pointRect(c.pos);
  }

  private resolvePlacement(loc: Location, dest: Placement, moverId: string | null, from: Pos | null): { pos: Pos; seatId: string | null } {
    const modes = [dest.x !== undefined || dest.y !== undefined, Boolean(dest.seat), Boolean(dest.near)].filter(Boolean).length;
    if (modes !== 1) throw new EngineError('Informe exatamente um destino: {x, y}, {seat} ou {near}.');

    if (dest.seat) {
      if (['random', 'aleatorio', 'qualquer'].includes(fold(dest.seat))) {
        const free = loc.fixtures
          .filter((f) => f.seat && f.kind !== 'bed')
          .flatMap((f) => {
            const p = this.freeSeatTile(f, moverId);
            return p ? [{ f, p }] : [];
          });
        if (!free.length) throw new EngineError(`Não há assentos livres em ${loc.name}.`);
        const pick = free[randInt(this.state, 0, free.length - 1)];
        return { pos: pick.p, seatId: pick.f.id };
      }
      const f = this.findFixture(dest.seat, loc.id);
      if (f.locationId !== loc.id) throw new EngineError(`${f.id} fica em outro local (${f.locationId}).`);
      if (!f.seat) throw new EngineError(`${f.id} (${f.label}) não é assento. Use {near: "${f.id}"} para ficar ao lado.`);
      const p = this.freeSeatTile(f, moverId);
      if (!p) {
        const who = this.characterAt(loc.id, f.x, f.y);
        throw new EngineError(`${f.id} já está ocupado(a)${who ? ` por ${who.name}` : ''}.`);
      }
      return { pos: p, seatId: f.id };
    }

    if (dest.near) {
      const rect = this.rectOf(dest.near, loc);
      const p = this.nearestFreeAround(loc, rect, from, moverId);
      if (!p) throw new EngineError(`Não há espaço livre ao lado de ${dest.near}.`);
      return { pos: p, seatId: null };
    }

    if (dest.x === undefined || dest.y === undefined) throw new EngineError('Informe x e y juntos.');
    const { x, y } = dest;
    if (x < 0 || y < 0 || x >= loc.width || y >= loc.height) {
      throw new EngineError(`(${x},${y}) está fora de ${loc.name} (${loc.width}×${loc.height}).`);
    }
    const f = fixtureAt(loc, x, y);
    if (f?.seat) {
      if (!this.freeTile(loc, x, y, moverId)) throw new EngineError(`${f.id} em (${x},${y}) já está ocupado(a).`);
      return { pos: { x, y }, seatId: f.id };
    }
    if (!isPassable(loc, x, y)) {
      const alt = this.nearestFreePassable(loc, { x, y });
      const label = f ? `${f.label} (${f.id})` : tileDef(loc, x, y).label;
      throw new EngineError(`(${x},${y}) é ${label}; não dá para ficar ali.${alt ? ` Tile livre mais próximo: (${alt.x},${alt.y}).` : ''}`);
    }
    const who = this.characterAt(loc.id, x, y);
    if (who && who.id !== moverId) throw new EngineError(`(${x},${y}) está ocupado por ${who.name}.`);
    return { pos: { x, y }, seatId: null };
  }

  private resolveFacing(c: Character, face: string): Dir {
    const alias = DIR_ALIASES[fold(face)];
    if (alias) return alias;
    if (!c.pos || !c.locationId) return c.facing;
    const loc = this.state.locations[c.locationId];
    return dirTowards(c.pos, rectCenter(this.rectOf(face, loc)));
  }

  private entrance(loc: Location): Pos | null {
    for (const door of loc.fixtures.filter((f) => f.kind === 'door')) {
      const p = this.nearestFreeAround(loc, door, null, null);
      if (p) return p;
    }
    return this.nearestFreePassable(loc, { x: Math.floor(loc.width / 2), y: Math.floor(loc.height / 2) });
  }

  // --------------------------------------------------------------- mutações

  log(kind: LogKind, text: string): void {
    this.state.log.push({ turn: this.state.turn, clock: { ...this.state.clock }, kind, text });
  }

  beginTurn(): number {
    return ++this.state.turn;
  }

  defineRuleset(input: {
    name: string;
    attributes: { id?: string; name: string; description: string }[];
    resources: { id?: string; name: string; max: number; description: string }[];
    dice?: string;
    difficulties?: Partial<Record<DifficultyName, number>>;
    notes?: string;
  }): Ruleset {
    if (Object.keys(this.state.characters).length) {
      throw new EngineError('As regras já estão em uso por personagens criados; defina o ruleset antes de criar personagens.');
    }
    const dice = input.dice ?? DEFAULT_RULESET.dice;
    if (!parseDice(dice)) throw new EngineError(`Dados inválidos: "${dice}". Use o formato NdM, por exemplo 2d6.`);
    const attributes = input.attributes.map((a) => ({ id: slugify(a.id ?? a.name, 20), name: a.name, description: a.description }));
    const resources = input.resources.map((r) => ({ id: slugify(r.id ?? r.name, 20), name: r.name, max: r.max, description: r.description }));
    const ids = [...attributes, ...resources].map((a) => a.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new EngineError(`Id repetido no ruleset: "${dup}".`);
    const difficulties = { ...DEFAULT_RULESET.difficulties, ...input.difficulties };
    const ladder = [difficulties.facil, difficulties.normal, difficulties.dificil, difficulties.muito_dificil];
    if (ladder.some((v, i) => i > 0 && v <= ladder[i - 1])) {
      throw new EngineError('As dificuldades precisam crescer: facil < normal < dificil < muito_dificil.');
    }
    this.state.ruleset = { name: input.name, attributes, resources, dice, difficulties, notes: input.notes ?? DEFAULT_RULESET.notes };
    return this.state.ruleset;
  }

  createLocation(spec: Omit<LocationSpec, 'id'> & { id?: string }): { location: Location; warnings: string[] } {
    const id = this.claimId(spec.id, spec.name, 'o local');
    const result = buildLocation({ ...spec, id });
    if (!result.ok) {
      throw new EngineError(
        `Layout inválido:\n- ${result.errors.join('\n- ')}${result.warnings.length ? `\nAvisos:\n- ${result.warnings.join('\n- ')}` : ''}`,
      );
    }
    this.state.locations[id] = result.location;
    return { location: result.location, warnings: result.warnings };
  }

  private statBlock(kind: 'atributo' | 'perícia', values: Record<string, number> | undefined, known: string[] | null): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [rawKey, value] of Object.entries(values ?? {})) {
      const key = known ? this.resolveAttributeId(rawKey) : slugify(rawKey, 24);
      if (!Number.isFinite(value)) throw new EngineError(`Valor inválido para ${kind} "${rawKey}".`);
      out[key] = clamp(Math.round(value), STAT_MIN, STAT_MAX);
    }
    return out;
  }

  private resolveAttributeId(ref: string): string {
    const f = fold(ref);
    const attr = this.state.ruleset.attributes.find((a) => a.id === slugify(ref, 20) || fold(a.name) === f);
    if (!attr) {
      const known = this.state.ruleset.attributes.map((a) => `${a.id} (${a.name})`).join(', ');
      throw new EngineError(`Atributo "${ref}" não existe nas regras. Atributos: ${known}.`);
    }
    return attr.id;
  }

  private resolveResourceId(ref: string): string {
    const f = fold(ref);
    const res = this.state.ruleset.resources.find((r) => r.id === slugify(ref, 20) || fold(r.name) === f);
    if (!res) {
      const known = this.state.ruleset.resources.map((r) => r.id).join(', ') || 'nenhum';
      throw new EngineError(`Recurso "${ref}" não existe nas regras. Recursos: ${known}.`);
    }
    return res.id;
  }

  createCharacter(input: CharacterInput): Character {
    if (input.is_player && this.player) {
      throw new EngineError(`Já existe um personagem do jogador: ${this.player.id} (${this.player.name}).`);
    }
    // Primeiro nome, pulando títulos abreviados ("Prof. Tanaka" → tanaka).
    const firstName = input.name.split(/\s+/).find((w) => w && !w.endsWith('.')) ?? input.name;
    const id = this.claimId(input.id, firstName, input.name);
    const rules = this.state.ruleset;
    const attributes = Object.fromEntries(rules.attributes.map((a) => [a.id, 1]));
    Object.assign(attributes, this.statBlock('atributo', input.attributes, rules.attributes.map((a) => a.id)));
    const resources = Object.fromEntries(rules.resources.map((r) => [r.id, r.max]));
    for (const [key, value] of Object.entries(input.resources ?? {})) {
      const rid = this.resolveResourceId(key);
      resources[rid] = clamp(Math.round(value), 0, rules.resources.find((r) => r.id === rid)!.max);
    }
    const c: Character = {
      id,
      name: input.name,
      isPlayer: Boolean(input.is_player),
      role: input.role,
      appearance: input.appearance,
      traits: input.traits ?? [],
      attributes,
      skills: this.statBlock('perícia', input.skills, null),
      resources,
      detail: input.personality || input.background ? 'full' : 'sketch',
      personality: input.personality ?? null,
      background: input.background ?? null,
      goals: input.goals ?? null,
      locationId: null,
      pos: null,
      facing: 'S',
      seatId: null,
    };
    if (!input.offscreen) {
      const locId = input.location_id ?? this.player?.locationId ?? this.lastLocationId();
      if (!locId) throw new EngineError('Crie um local antes (create_location) ou marque offscreen=true.');
      const loc = this.findLocation(locId);
      const spot = input.position
        ? this.resolvePlacement(loc, input.position, null, null)
        : (() => {
            const p = this.entrance(loc);
            if (!p) throw new EngineError(`Não há espaço livre em ${loc.name}.`);
            return { pos: p, seatId: null };
          })();
      c.locationId = loc.id;
      c.pos = spot.pos;
      c.seatId = spot.seatId;
      c.facing = spot.seatId ? this.findFixture(spot.seatId).facing : 'S';
    }
    this.state.characters[id] = c;
    if (c.isPlayer) this.state.playerId = id;
    if (input.facing) c.facing = this.resolveFacing(c, input.facing);
    return c;
  }

  moveCharacter(input: { character_id: string; to: Placement & { location_id?: string }; face?: string }) {
    const c = this.findCharacter(input.character_id);
    const targetLoc = input.to.location_id ? this.findLocation(input.to.location_id) : c.locationId ? this.state.locations[c.locationId] : null;
    if (!targetLoc) throw new EngineError(`${c.name} não está em nenhum local; informe to.location_id.`);
    const changing = targetLoc.id !== c.locationId;
    const hasSpot = input.to.x !== undefined || input.to.y !== undefined || input.to.seat || input.to.near;
    const from = c.pos ? { location: c.locationId, x: c.pos.x, y: c.pos.y, seat: c.seatId } : null;
    let path: Pos[] | null = null;
    let spot: { pos: Pos; seatId: string | null };
    if (changing) {
      if (hasSpot) spot = this.resolvePlacement(targetLoc, input.to, c.id, null);
      else {
        const p = this.entrance(targetLoc);
        if (!p) throw new EngineError(`Não há espaço livre em ${targetLoc.name}.`);
        spot = { pos: p, seatId: null };
      }
    } else {
      if (!hasSpot) throw new EngineError('Informe o destino: {x, y}, {seat}, {near} ou {location_id} de outro local.');
      spot = this.resolvePlacement(targetLoc, input.to, c.id, c.pos);
      if (c.pos) {
        path = this.findPath(targetLoc, c.pos, spot.pos);
        if (!path) throw new EngineError(`${c.name} não tem caminho de (${c.pos.x},${c.pos.y}) até (${spot.pos.x},${spot.pos.y}).`);
      }
    }
    c.locationId = targetLoc.id;
    c.pos = spot.pos;
    c.seatId = spot.seatId;
    if (spot.seatId) c.facing = this.findFixture(spot.seatId).facing;
    else if (path && path.length > 1) c.facing = dirTowards(path[path.length - 2], path[path.length - 1]);
    if (input.face) c.facing = this.resolveFacing(c, input.face);
    return {
      character_id: c.id,
      from,
      to: { location: targetLoc.id, x: spot.pos.x, y: spot.pos.y, seat: spot.seatId },
      steps: path ? path.length - 1 : null,
      facing: c.facing,
      path: path ?? undefined,
    };
  }

  updateCharacter(input: CharacterUpdate) {
    const c = this.findCharacter(input.character_id);
    const changes: string[] = [];
    for (const key of ['name', 'role', 'appearance', 'personality', 'background', 'goals'] as const) {
      const value = input[key];
      if (value !== undefined && value !== c[key]) {
        c[key] = value;
        changes.push(key);
      }
    }
    if (input.traits_add?.length) {
      c.traits.push(...input.traits_add.filter((t) => !c.traits.includes(t)));
      changes.push('traits');
    }
    if (input.traits_remove?.length) {
      const remove = new Set(input.traits_remove.map(fold));
      c.traits = c.traits.filter((t) => !remove.has(fold(t)));
      changes.push('traits');
    }
    if (input.attributes) {
      Object.assign(c.attributes, this.statBlock('atributo', input.attributes, this.state.ruleset.attributes.map((a) => a.id)));
      changes.push('attributes');
    }
    if (input.skills) {
      for (const [key, value] of Object.entries(this.statBlock('perícia', input.skills, null))) {
        if (value === 0) delete c.skills[key];
        else c.skills[key] = value;
      }
      changes.push('skills');
    }
    const resourceChanges: string[] = [];
    const applyResource = (key: string, next: (cur: number) => number) => {
      const rid = this.resolveResourceId(key);
      const max = this.state.ruleset.resources.find((r) => r.id === rid)!.max;
      const before = c.resources[rid] ?? max;
      c.resources[rid] = clamp(Math.round(next(before)), 0, max);
      resourceChanges.push(`${rid} ${before}→${c.resources[rid]}/${max}`);
    };
    for (const [key, value] of Object.entries(input.resources_set ?? {})) applyResource(key, () => value);
    for (const [key, delta] of Object.entries(input.resource_deltas ?? {})) applyResource(key, (cur) => cur + delta);
    if (c.personality || c.background) c.detail = 'full';
    return { character_id: c.id, changed: [...new Set(changes)], resources: resourceChanges, detail: c.detail };
  }

  private resolveHolder(ref: HolderRef, fallbackLocationId: string | null): ItemHolder {
    const modes = [ref.character_id, ref.fixture_id, ref.x !== undefined || ref.y !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new EngineError('Informe exatamente um destino: {character_id}, {fixture_id} ou {x, y} (+ location_id).');
    if (ref.character_id) return { kind: 'character', id: this.findCharacter(ref.character_id).id };
    if (ref.fixture_id) return { kind: 'fixture', id: this.findFixture(ref.fixture_id, ref.location_id ?? fallbackLocationId).id };
    if (ref.x === undefined || ref.y === undefined) throw new EngineError('Informe x e y juntos.');
    const locId = ref.location_id ?? fallbackLocationId;
    if (!locId) throw new EngineError('Informe location_id para colocar o item no chão.');
    const loc = this.findLocation(locId);
    const f = fixtureAt(loc, ref.x, ref.y);
    if (f) return { kind: 'fixture', id: f.id };
    if (!isPassable(loc, ref.x, ref.y)) throw new EngineError(`(${ref.x},${ref.y}) em ${loc.id} não é chão.`);
    return { kind: 'ground', locationId: loc.id, x: ref.x, y: ref.y };
  }

  /** Onde o item (ou destino) está fisicamente; null se estiver fora de cena. */
  private holderPlace(h: ItemHolder): { locationId: string; rect: Rect } | null {
    if (h.kind === 'ground') return { locationId: h.locationId, rect: pointRect(h) };
    if (h.kind === 'fixture') {
      const f = this.findFixture(h.id);
      return { locationId: f.locationId, rect: f };
    }
    const c = this.state.characters[h.id];
    return c?.locationId && c.pos ? { locationId: c.locationId, rect: pointRect(c.pos) } : null;
  }

  createItem(input: { id?: string; name: string; description: string; tags?: string[]; quantity?: number; holder: HolderRef }): Item {
    const holder = this.resolveHolder(input.holder, this.currentLocation?.id ?? null);
    const quantity = Math.max(1, Math.round(input.quantity ?? 1));
    const item: Item = {
      id: this.claimId(input.id, input.name, input.name),
      name: input.name,
      description: input.description,
      tags: input.tags ?? [],
      quantity,
      holder,
    };
    this.state.items[item.id] = item;
    return item;
  }

  transferItem(input: { item_id: string; to: HolderRef; quantity?: number; thrown?: boolean }) {
    const item = this.findItem(input.item_id);
    const fallbackLoc = this.holderPlace(item.holder)?.locationId ?? this.currentLocation?.id ?? null;
    const holder = this.resolveHolder(input.to, fallbackLoc);
    if (JSON.stringify(holder) === JSON.stringify(item.holder)) {
      throw new EngineError(`${item.name} já está ${this.describeHolder(holder)}.`);
    }
    const src = this.holderPlace(item.holder);
    const dst = this.holderPlace(holder);
    if (src && dst) {
      if (src.locationId !== dst.locationId) {
        throw new EngineError(`${item.name} está em ${src.locationId} e o destino em ${dst.locationId}. Mova alguém primeiro (move_character).`);
      }
      const gap = rectGap(src.rect, dst.rect);
      const limit = input.thrown ? THROW_REACH : REACH;
      if (gap > limit) {
        throw new EngineError(
          `${item.name} está a ${gap} tiles do destino (alcance ${limit}). Aproxime os personagens com move_character` +
            `${input.thrown ? '' : ' ou use thrown=true para arremessar'}.`,
        );
      }
    }
    const qty = input.quantity === undefined ? item.quantity : Math.round(input.quantity);
    if (qty < 1 || qty > item.quantity) throw new EngineError(`Quantidade inválida: ${item.name} tem ${item.quantity}.`);
    const from = this.describeHolder(item.holder);
    let moved = item;
    if (qty < item.quantity) {
      item.quantity -= qty;
      moved = { ...structuredClone(item), id: this.uniqueId(item.id), quantity: qty, holder };
      this.state.items[moved.id] = moved;
    } else {
      item.holder = holder;
    }
    return { item_id: moved.id, name: moved.name, quantity: qty, from, to: this.describeHolder(holder) };
  }

  updateItem(input: { item_id: string; name?: string; description?: string; tags?: string[]; quantity_delta?: number; destroy?: boolean }) {
    const item = this.findItem(input.item_id);
    if (input.name) item.name = input.name;
    if (input.description) item.description = input.description;
    if (input.tags) item.tags = input.tags;
    if (input.quantity_delta) item.quantity += Math.round(input.quantity_delta);
    if (input.destroy || item.quantity <= 0) {
      delete this.state.items[item.id];
      return { item_id: item.id, destroyed: true };
    }
    return { item_id: item.id, destroyed: false, quantity: item.quantity, name: item.name };
  }

  updateFixture(input: { fixture_id: string; text?: string; append_text?: string; state?: string }) {
    const f = this.findFixture(input.fixture_id);
    if (input.text !== undefined) f.text = input.text;
    if (input.append_text) f.text = f.text ? `${f.text}\n${input.append_text}` : input.append_text;
    if (input.state !== undefined) f.state = input.state;
    if (f.text.length > 600) throw new EngineError('O texto do móvel passou de 600 caracteres; apague parte antes (text).');
    return { fixture_id: f.id, text: f.text, state: f.state };
  }

  skillCheck(input: { character_id: string; attribute: string; skill?: string; difficulty: DifficultyName | number; modifier?: number; reason: string }) {
    const c = this.findCharacter(input.character_id);
    const attrId = this.resolveAttributeId(input.attribute);
    const attr = this.state.ruleset.attributes.find((a) => a.id === attrId)!;
    const skill = input.skill ? slugify(input.skill, 24) : null;
    const skillValue = skill ? (c.skills[skill] ?? 0) : 0;
    const target = typeof input.difficulty === 'number' ? input.difficulty : this.state.ruleset.difficulties[input.difficulty];
    if (target === undefined) throw new EngineError(`Dificuldade inválida: ${String(input.difficulty)}.`);
    const dice = parseDice(this.state.ruleset.dice)!;
    const rolls = rollDice(this.state, dice.count, dice.sides);
    const modifier = Math.round(input.modifier ?? 0);
    const total = rolls.reduce((a, b) => a + b, 0) + dice.bonus + (c.attributes[attrId] ?? 0) + skillValue + modifier;
    const margin = total - target;
    const success = margin >= 0;
    const degree = margin >= 4 ? 'sucesso pleno' : success ? 'sucesso' : margin <= -4 ? 'falha grave' : 'falha';
    return {
      character_id: c.id,
      character: c.name,
      attribute: { id: attrId, name: attr.name, value: c.attributes[attrId] ?? 0 },
      skill: skill ? { id: skill, value: skillValue } : null,
      modifier,
      dice: this.state.ruleset.dice,
      rolls,
      total,
      target,
      difficulty: typeof input.difficulty === 'number' ? String(input.difficulty) : DIFFICULTY_LABEL[input.difficulty],
      success,
      margin,
      degree,
      reason: input.reason,
    };
  }

  random(input: { min?: number; max?: number; options?: string[]; count?: number; dice?: string; reason?: string }): RandomResult {
    const modes = [input.min !== undefined || input.max !== undefined, Boolean(input.options), Boolean(input.dice)].filter(Boolean).length;
    if (modes !== 1) throw new EngineError('Use exatamente um modo: {min, max}, {options, count} ou {dice}.');
    if (input.dice) {
      const d = parseDice(input.dice);
      if (!d) throw new EngineError(`Dados inválidos: "${input.dice}".`);
      const rolls = rollDice(this.state, d.count, d.sides);
      return { mode: 'dice', dice: input.dice, rolls, total: rolls.reduce((a, b) => a + b, 0) + d.bonus };
    }
    if (input.options) {
      if (!input.options.length) throw new EngineError('options está vazio.');
      const count = clamp(Math.round(input.count ?? 1), 1, input.options.length);
      return { mode: 'pick', picked: pickMany(this.state, input.options, count) };
    }
    if (input.min === undefined || input.max === undefined) throw new EngineError('Informe min e max juntos.');
    const lo = Math.round(Math.min(input.min, input.max));
    const hi = Math.round(Math.max(input.min, input.max));
    return { mode: 'range', min: lo, max: hi, value: randInt(this.state, lo, hi) };
  }

  private resolveSubject(subject: string): string {
    for (const find of [
      () => this.findCharacter(subject).id,
      () => this.findLocation(subject).id,
      () => this.findItem(subject).id,
    ]) {
      try {
        return find();
      } catch {
        // tenta o próximo tipo
      }
    }
    return subject.trim();
  }

  /**
   * Quem fica sabendo: 'all' (público), 'present' (quem está no local agora) ou uma lista
   * de ids, que pode incluir 'present' e 'player'. 'present' vira uma lista fixa de ids:
   * quem chegar depois não sabe.
   */
  private resolveKnowers(spec: string[] | 'all' | 'present', locationId: string | null): string[] | 'all' {
    if (spec === 'all') return 'all';
    const ids = new Set<string>();
    for (const ref of spec === 'present' ? ['present'] : spec) {
      if (['present', 'presentes'].includes(fold(ref))) {
        const loc = locationId ?? this.player?.locationId ?? null;
        if (!loc) throw new EngineError('Não há ninguém em cena para "present"; informe os ids.');
        for (const c of this.charactersIn(loc)) ids.add(c.id);
      } else ids.add(this.findCharacter(ref).id);
    }
    return [...ids];
  }

  knows(characterId: string, fact: Fact): boolean {
    return fact.knownBy === 'all' || fact.knownBy.includes(characterId);
  }

  findFact(ref: string): Fact {
    const fact = this.state.facts.find((f) => f.id === ref || f.id === slugify(ref));
    if (!fact) throw new EngineError(`Fato "${ref}" não existe. Use recall para achar o id.`);
    return fact;
  }

  addFact(input: { subject: string; text: string; known_by: string[] | 'all' | 'present' }): Fact {
    const fact: Fact = {
      id: `fato_${this.nextCounter('fact')}`,
      subject: this.resolveSubject(input.subject),
      text: input.text,
      knownBy: this.resolveKnowers(input.known_by, null),
      turn: this.state.turn,
      clock: { ...this.state.clock },
    };
    this.state.facts.push(fact);
    return fact;
  }

  /** Alguém ficou sabendo de um fato. Só quem sabe pode contar. */
  shareKnowledge(input: { fact_id: string; to: string[] | 'present'; from?: string; how?: string }) {
    const fact = this.findFact(input.fact_id);
    if (fact.knownBy === 'all') return { fact_id: fact.id, learned: [] as string[], known_by: 'all' as const };
    const from = input.from ? this.findCharacter(input.from) : null;
    if (from && !this.knows(from.id, fact)) {
      const who = fact.knownBy.map((id) => this.state.characters[id]?.name ?? id).join(', ') || 'ninguém';
      throw new EngineError(`${from.name} não sabe disso (${fact.id}), então não pode contar. Quem sabe: ${who}.`);
    }
    const targets = this.resolveKnowers(input.to, from?.locationId ?? null) as string[];
    const learned = targets.filter((id) => !this.knows(id, fact));
    fact.knownBy = [...fact.knownBy, ...learned];
    return { fact_id: fact.id, learned, known_by: fact.knownBy };
  }

  factsAbout(ids: Set<string>, limit: number): Fact[] {
    return this.state.facts.filter((f) => ids.has(f.subject)).slice(-limit).reverse();
  }

  recall(input: { subject?: string; query?: string; known_by?: string; limit?: number }) {
    const limit = clamp(Math.round(input.limit ?? 12), 1, 40);
    const subject = input.subject ? this.resolveSubject(input.subject) : null;
    const knower = input.known_by ? this.findCharacter(input.known_by).id : null;
    const tokens = input.query ? fold(input.query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3) : [];
    const scored = this.state.facts
      .filter((f) => (!subject || f.subject === subject) && (!knower || this.knows(knower, f)))
      .map((f) => {
        const hay = fold(`${f.subject} ${f.text}`);
        return { f, score: tokens.length ? tokens.filter((t) => hay.includes(t)).length : 1 };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.f.turn - a.f.turn);
    const threads = Object.values(this.state.threads).filter((t) => {
      if (!tokens.length) return !subject;
      const hay = fold(`${t.title} ${t.description}`);
      return tokens.some((tok) => hay.includes(tok));
    });
    return {
      facts: scored.slice(0, limit).map(({ f }) => ({
        id: f.id,
        subject: f.subject,
        text: f.text,
        known_by: f.knownBy,
        when: `T${f.turn}, ${formatClock(f.clock)}`,
      })),
      threads: threads.map((t) => ({ id: t.id, title: t.title, status: t.status, description: t.description })),
      total_matches: scored.length,
    };
  }

  updateThread(input: { id?: string; title?: string; description?: string; status?: ThreadStatus }): Thread {
    const existing = input.id ? (this.state.threads[input.id] ?? this.state.threads[slugify(input.id)]) : undefined;
    if (existing) {
      if (input.title) existing.title = input.title;
      if (input.description) existing.description = input.description;
      if (input.status) existing.status = input.status;
      existing.updatedTurn = this.state.turn;
      return existing;
    }
    if (!input.title) throw new EngineError(input.id ? `Fio "${input.id}" não existe; para criar, informe title.` : 'Informe title para criar um fio.');
    const thread: Thread = {
      id: this.uniqueId(`fio_${slugify(input.id ?? input.title, 24)}`),
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'open',
      updatedTurn: this.state.turn,
    };
    this.state.threads[thread.id] = thread;
    return thread;
  }

  advanceTime(input: { minutes?: number; to?: string; reason?: string }): { from: string; to: string } {
    const before: Clock = { ...this.state.clock };
    if ((input.minutes === undefined) === (input.to === undefined)) throw new EngineError('Informe minutes ou to (HH:MM), um dos dois.');
    if (input.to !== undefined) {
      const target = parseHHMM(input.to);
      if (target === null) throw new EngineError(`Horário inválido: "${input.to}". Use HH:MM.`);
      if (this.state.turn === 0) {
        // Durante a criação do mundo, `to` define o horário inicial.
        this.state.clock.minutes = target;
      } else {
        const delta = (target - this.state.clock.minutes + 1440) % 1440;
        if (delta === 0) throw new EngineError(`Já são ${input.to}.`);
        this.state.clock.minutes += delta;
      }
    } else {
      const minutes = Math.round(input.minutes!);
      if (minutes < 1 || minutes > 10080) throw new EngineError('minutes deve ficar entre 1 e 10080 (uma semana).');
      this.state.clock.minutes += minutes;
    }
    while (this.state.clock.minutes >= 1440) {
      this.state.clock.minutes -= 1440;
      this.state.clock.day += 1;
    }
    return { from: formatClock(before), to: formatClock(this.state.clock) };
  }

  // ------------------------------------------------------------- descrições

  sheet(c: Character) {
    const rules = this.state.ruleset;
    return {
      id: c.id,
      name: c.name,
      player: c.isPlayer,
      role: c.role,
      appearance: c.appearance,
      traits: c.traits,
      detail: c.detail,
      personality: c.personality,
      background: c.background,
      goals: c.goals,
      attributes: c.attributes,
      skills: c.skills,
      resources: Object.fromEntries(rules.resources.map((r) => [r.id, `${c.resources[r.id] ?? r.max}/${r.max}`])),
      location: c.locationId,
      position: c.pos,
      seated_at: c.seatId,
      facing: c.facing,
      inventory: this.itemsHeldBy(c.id).map((i) => ({ id: i.id, name: i.name, quantity: i.quantity })),
      facts: this.factsAbout(new Set([c.id]), 12).map((f) => ({ id: f.id, text: f.text, known_by: f.knownBy })),
      knows: this.state.facts
        .filter((f) => f.knownBy !== 'all' && f.knownBy.includes(c.id))
        .slice(-15)
        .map((f) => ({ id: f.id, text: f.text })),
    };
  }

  inspect(ids: string[]): Record<string, unknown>[] {
    const s = this.state;
    return ids.map((ref) => {
      if (s.characters[ref]) return { type: 'character', ...this.sheet(s.characters[ref]) };
      if (s.items[ref]) {
        const i = s.items[ref];
        return { type: 'item', id: i.id, name: i.name, description: i.description, tags: i.tags, quantity: i.quantity, where: this.describeHolder(i.holder) };
      }
      if (s.locations[ref]) {
        const l = s.locations[ref];
        return {
          type: 'location',
          id: l.id,
          name: l.name,
          description: l.description,
          size: `${l.width}×${l.height}`,
          layout: l.tiles,
          fixtures: l.fixtures.map((f) => `${f.id} (${f.label}) em (${f.x},${f.y})${f.w > 1 || f.h > 1 ? ` ${f.w}×${f.h}` : ''}`),
          characters: this.charactersIn(l.id).map((c) => `${c.id} (${c.name}) em (${c.pos?.x},${c.pos?.y})`),
          items_on_ground: this.itemsOnGround(l.id).map((i) => `${i.id} (${i.name})`),
        };
      }
      if (s.threads[ref]) return { type: 'thread', ...s.threads[ref] };
      const fact = s.facts.find((f) => f.id === ref);
      if (fact) return { type: 'fact', ...fact };
      try {
        const f = this.findFixture(ref);
        return {
          type: 'fixture',
          ...f,
          occupants: this.charactersIn(f.locationId)
            .filter((c) => c.seatId === f.id)
            .map((c) => c.id),
          items: this.itemsOn(f.id).map((i) => ({ id: i.id, name: i.name })),
        };
      } catch {
        // tenta pelo nome
      }
      for (const find of [() => this.findCharacter(ref), () => this.findItem(ref)]) {
        try {
          const found = find();
          return this.inspect([found.id])[0];
        } catch {
          // segue
        }
      }
      return { type: 'unknown', id: ref, error: `Nada encontrado com "${ref}".` };
    });
  }
}
