import { GRIPS, GRIP_IDS, POSES, POSE_IDS, gripOf, handFor } from './body';
import { modelCatalog, portable, sizeLabel, type CatalogItem } from './catalog';
import { DECOR_IDS, ERAS, ERA_LOOK, PACK_ERA, outOfEra } from './eras';
import { MAX_FRAMES, snapshotScene } from './frames';
import { LEGEND, buildLocation, defaultExits, fixtureAt, isPassable, rectCenter, tileDef, tileOf, type LocationSpec } from './layout';
import { findPath as searchPath } from './path';
import { OBJECT_LIBRARY, findObjectType, librarySummary, objectType, resolveType, typeChain } from './objects';
import { DEFAULT_VISION, sightOf, type Sight } from './perception';
import { parseDice, pickMany, randInt, rollDice } from './rng';
import { analyzeSpeech } from './speech';
import { buildTemplate, type TemplateName, type TemplateOptions } from './templates';
import { addMinutes, chebyshev, clockMinutes, dirTowards, fold, formatClock, hhmm, parseHHMM, slugify } from './text';
import type {
  Character,
  Clock,
  Dir,
  DifficultyName,
  Era,
  Fact,
  FloorStyle,
  Figure,
  Fixture,
  Grip,
  Hand,
  Item,
  ItemHolder,
  Location,
  LightSpec,
  LogKind,
  ObjectType,
  PerkDef,
  PerkGrant,
  Pos,
  ReadyLine,
  ResourceDef,
  Ruleset,
  SpeechMode,
  Thread,
  ThreadStatus,
  TileDef,
  Visibility,
  WallMaterial,
  WorldState,
} from './types';

/** Erro de regra do mundo: a mensagem volta para o modelo como resultado da tool. */
export class EngineError extends Error {}

export const STAT_MIN = 0;
export const STAT_MAX = 5;

/** Recursos que todo personagem tem, em qualquer gênero, mesmo ocultos. */
export const CORE_RESOURCES: ResourceDef[] = [
  { id: 'vida', name: 'Vida', max: 10, description: 'saúde física; em 0 o personagem está fora de ação', visibility: 'hidden', core: true },
];
const CORE_ALIASES: Record<string, string[]> = { vida: ['vida', 'hp', 'saude', 'pontos_de_vida', 'health'] };

/**
 * Modos de fala padrão. A voz normal cobre uma sala de aula. Cochichar exige estar colado, e o
 * conteúdo é só do alvo: som 0,5 não alcança nem quem está do lado, a não ser com audição
 * aguçada (×2 já ouve a 1 tile).
 */
export const DEFAULT_SPEECH: Record<string, SpeechMode> = {
  fala: { label: 'fala', reach: 12, channels: { som: 12, labios: 6 } },
  cochicho: { label: 'cochicha', reach: 2, channels: { som: 0.5, labios: 3 } },
  grito: { label: 'grita', reach: 40, channels: { som: 40, labios: 8 } },
};

/** Todo mundo ouve (som 1) e enxerga (visao 1); ler lábios e mentes só com perk. */
export const DEFAULT_SENSES: Record<string, number> = { som: 1, labios: 0, mente: 0, visao: 1 };

/** Ler lábios exige ver a boca de quem fala. */
export const DEFAULT_SIGHT_CHANNELS = ['labios'];

/** Condições prontas; o mestre cria outras com extend_ruleset. */
export const DEFAULT_CONDITIONS: PerkDef[] = [
  { id: 'cego', name: 'Cego', description: 'não enxerga nada', grants: [{ kind: 'sense', channel: 'visao', factor: 0 }] },
  { id: 'visao_turva', name: 'Visão turva', description: 'enxerga de perto; de longe, só vultos', grants: [{ kind: 'sense', channel: 'visao', factor: 0.5 }] },
  { id: 'ofuscado', name: 'Ofuscado', description: 'a vista ainda não voltou depois de um clarão', grants: [{ kind: 'sense', channel: 'visao', factor: 0.2 }] },
  { id: 'surdo', name: 'Surdo', description: 'não ouve nada', grants: [{ kind: 'sense', channel: 'som', factor: 0 }] },
];

export const DEFAULT_REACHES: Record<string, number> = {
  toque: 1,
  corpo_a_corpo: 1,
  entregar: 2,
  arremesso: 8,
  visao: 40,
};

export const DEFAULT_RULESET: Ruleset = {
  name: 'Sistema Universal CRPS',
  attributes: [
    { id: 'corpo', name: 'Corpo', description: 'força, resistência e agilidade', visibility: 'self', default: 1 },
    { id: 'mente', name: 'Mente', description: 'raciocínio, memória e percepção', visibility: 'self', default: 1 },
    { id: 'presenca', name: 'Presença', description: 'carisma, empatia e autocontrole', visibility: 'self', default: 1 },
  ],
  resources: [...CORE_RESOURCES, { id: 'energia', name: 'Energia', max: 10, description: 'disposição física e mental', visibility: 'self' }],
  perks: [],
  conditions: DEFAULT_CONDITIONS,
  speech: DEFAULT_SPEECH,
  senses: DEFAULT_SENSES,
  sightChannels: DEFAULT_SIGHT_CHANNELS,
  vision: DEFAULT_VISION,
  reaches: DEFAULT_REACHES,
  dice: '2d6',
  difficulties: { facil: 7, normal: 9, dificil: 11, muito_dificil: 13 },
  notes: 'Atributos e perícias vão de 0 a 5 (1 = mediano, 3 = muito bom, 5 = lendário).',
};

export const VISIBILITY_LABEL: Record<Visibility, string> = { public: 'público', self: 'só o próprio', hidden: 'oculto' };

/** Corpos do 3D; um personagem do catálogo pode ser também criatura, que fica sem corpo informado. */
const FIGURES = new Set<string>(['adulto', 'adulta', 'menino', 'menina']);

/** Garante os recursos universais; um recurso equivalente definido pelo mestre (ex.: "HP") vira o universal. */
function ensureCoreResources(rules: Ruleset): void {
  for (const core of [...CORE_RESOURCES].reverse()) {
    const same = rules.resources.find((r) => CORE_ALIASES[core.id].includes(r.id) || CORE_ALIASES[core.id].includes(slugify(r.name, 20)));
    if (same) same.core = true;
    else rules.resources.unshift({ ...core });
  }
}

/** Saves antigos: campos que surgiram depois ganham valores padrão. */
function migrate(state: WorldState): WorldState {
  state.frames ??= [];
  const rules = state.ruleset;
  rules.perks ??= [];
  rules.speech ??= structuredClone(DEFAULT_SPEECH);
  rules.senses ??= { ...DEFAULT_SENSES };
  rules.senses.visao ??= 1;
  rules.sightChannels ??= [...DEFAULT_SIGHT_CHANNELS];
  rules.vision ??= { ...DEFAULT_VISION };
  rules.conditions ??= structuredClone(DEFAULT_CONDITIONS);
  rules.reaches ??= { ...DEFAULT_REACHES };
  state.objectTypes ??= {};
  for (const l of Object.values(state.locations)) {
    l.light ??= 1;
    // Saves de antes dos tipos como dado: a saída vem do tipo (porta, elevador, escada).
    for (const f of l.fixtures) {
      const exit = OBJECT_LIBRARY[f.kind]?.exit;
      if (exit && !f.exit) f.exit = exit;
    }
    l.exits ??= defaultExits(l.fixtures);
    // Saves de antes dos andares: um destino só, ou null.
    for (const e of Object.values(l.exits)) {
      const to = e.to as unknown;
      if (!Array.isArray(to)) e.to = typeof to === 'string' ? [to] : [];
    }
  }
  for (const a of rules.attributes) {
    a.visibility ??= 'self';
    a.default ??= 1;
  }
  for (const r of rules.resources) r.visibility ??= 'self';
  ensureCoreResources(rules);
  // Grafo de conhecidos: antes dele todos apareciam pelo nome, então nos saves antigos todos se conhecem.
  const ids = Object.keys(state.characters);
  let voicesMissing = false;
  for (const c of Object.values(state.characters)) {
    c.perks ??= [];
    c.conditions ??= [];
    c.thoughts ??= null;
    c.feelings ??= {};
    for (const r of rules.resources) c.resources[r.id] ??= r.max;
    c.knows ??= ids.filter((id) => id !== c.id);
    // Falas prontas de antes dos fatos e dos nomes: só o texto.
    if (c.lines) {
      for (const key of ['turn', 'general'] as const) {
        c.lines[key] = (c.lines[key] as unknown[]).map((l) => (typeof l === 'string' ? { text: l } : l)) as ReadyLine[];
      }
    }
    if (!c.voices) {
      c.voices = {};
      voicesMissing = true;
    }
  }
  // E as vozes da última narração: quem ouviu um conhecido falar continua sabendo quem é.
  const last = voicesMissing ? state.log.findLast((e) => e.kind === 'narration') : undefined;
  if (last) hearVoices(state, analyzeSpeech(state, last.text).lines);
  return state;
}

/** Quem ouve um conhecido falar sabe quem é, mesmo sem ver, enquanto os dois seguirem ali. */
function hearVoices(state: WorldState, lines: { speakerId: string; hearers: string[] }[]): void {
  for (const line of lines) {
    const at = state.characters[line.speakerId]?.locationId;
    if (!at) continue;
    for (const id of line.hearers) {
      const c = state.characters[id];
      if (c && id !== line.speakerId && c.knows.includes(line.speakerId)) c.voices[line.speakerId] = at;
    }
  }
}

export interface AttributeInput {
  id?: string;
  name: string;
  description: string;
  visibility?: Visibility;
  default?: number;
}

export interface ResourceInput {
  id?: string;
  name: string;
  max: number;
  description: string;
  visibility?: Visibility;
  /** Valor inicial de quem já existe (padrão: o máximo). */
  start?: number;
}

/** Como o mestre descreve um efeito: igual a PerkGrant, com a força da luz opcional. */
export type PerkGrantInput = Exclude<PerkGrant, { kind: 'light' }> | { kind: 'light'; radius: number; intensity?: number; color?: string };

export interface PerkInput {
  id?: string;
  name: string;
  description: string;
  grants: PerkGrantInput[];
}

export interface LightInput {
  radius: number;
  intensity?: number;
  color?: string;
  on?: boolean;
}

/** Luz validada: raio de 0,5 a 40 tiles, força de 0,05 a 1 (padrão 0,9). */
function lightSpec(l: LightInput): LightSpec {
  if (!(l.radius > 0)) throw new EngineError('A luz precisa de radius maior que 0 (em tiles).');
  return {
    radius: clamp(Math.round(l.radius * 10) / 10, 0.5, 40),
    intensity: clamp(l.intensity ?? 0.9, 0.05, 1),
    ...(l.color ? { color: l.color } : {}),
  };
}

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

/** Para onde leva uma saída do local: destino (id de local, pode ainda não existir) e nome. */
/** Tipo de objeto novo, na legenda de um local: o que não for informado vem do parecido (like). */
export type ObjectTypeInput = Omit<ObjectType, 'id' | 'char' | 'slug'>;

/** Uma fala pronta como o mestre manda em set_lines. */
export interface LineInput {
  text: string;
  fact_id?: string;
  introduces?: boolean;
  whisper?: boolean;
}

export interface ExitInput {
  fixture: string;
  to?: string;
  label?: string;
}

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
  /** Com character_id: na mão, empunhado. */
  hand?: Hand;
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
  figure?: Figure;
  look?: string;
  seen_as?: string;
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
  perks?: string[];
  thoughts?: string;
}

export interface CharacterUpdate {
  character_id: string;
  name?: string;
  role?: string;
  appearance?: string;
  figure?: Figure;
  look?: string;
  seen_as?: string;
  traits_add?: string[];
  traits_remove?: string[];
  personality?: string;
  background?: string;
  goals?: string;
  attributes?: Record<string, number>;
  skills?: Record<string, number>;
  resource_deltas?: Record<string, number>;
  resources_set?: Record<string, number>;
  perks_add?: string[];
  perks_remove?: string[];
  /** Condições novas; `minutes` = quanto tempo duram (sem minutes, até alguém tirar). */
  conditions_add?: (string | { id: string; minutes?: number })[];
  conditions_remove?: string[];
  thoughts?: string;
  /** Pose do corpo (body.ts); de_pe volta ao normal. */
  pose?: string;
  /** Para quem ou o quê a pose se volta; vazio tira. */
  pose_target?: string;
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
      objectTypes: {},
    });
  }

  static fromJSON(json: string): GameEngine {
    const state = JSON.parse(json) as WorldState;
    if (state.version !== 1) throw new Error(`Versão de save não suportada: ${String(state.version)}`);
    return new GameEngine(migrate(state));
  }

  toJSON(): string {
    return JSON.stringify(this.state);
  }

  /** Cópia para o cliente, com histórico e retratos encurtados e a narração como o jogador a percebeu. */
  snapshot(maxLog = 200, maxFrames = 80): WorldState {
    const copy = structuredClone(this.state);
    copy.log = copy.log.slice(-maxLog).map(({ playerText, ...e }) => (playerText === undefined ? e : { ...e, text: playerText }));
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
    if (h.kind === 'character') return `${h.hand ? `na mão ${h.hand} de` : 'com'} ${this.state.characters[h.id]?.name ?? h.id}`;
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

  /** Caminho até um tile do local (A*, em path.ts), desviando de quem está parado no meio. */
  findPath(loc: Location, from: Pos, to: Pos, moverId: string | null = null): Pos[] | null {
    return searchPath(loc, from, to, (x, y) => !this.freeTile(loc, x, y, moverId));
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
        const path = this.findPath(loc, from, p, moverId);
        if (path && (!best || path.length < best.len)) best = { p, len: path.length };
      }
      if (best) return best.p;
    }
    const c = rectCenter(target);
    return candidates.sort((a, b) => Math.hypot(a.x - c.x, a.y - c.y) - Math.hypot(b.x - c.x, b.y - c.y))[0];
  }

  /** Para onde vai um clique no chão: o próprio tile, se dá para ficar nele, ou o livre mais perto. */
  walkTarget(locationId: string, p: Pos, moverId: string): Pos | null {
    const loc = this.state.locations[locationId];
    if (!loc) return null;
    if (isPassable(loc, p.x, p.y) && this.freeTile(loc, p.x, p.y, moverId)) return p;
    return this.nearestFreePassable(loc, p);
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
          .filter((f) => f.seat && !this.typeOf(f.kind).bed)
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
    for (const door of loc.fixtures.filter((f) => f.exit)) {
      const p = this.nearestFreeAround(loc, door, null, null);
      if (p) return p;
    }
    return this.nearestFreePassable(loc, { x: Math.floor(loc.width / 2), y: Math.floor(loc.height / 2) });
  }

  // --------------------------------------------------------------- mutações

  log(kind: LogKind, text: string, playerText?: string, options?: string[]): void {
    this.state.log.push({
      turn: this.state.turn,
      clock: { ...this.state.clock },
      kind,
      text,
      ...(playerText !== undefined ? { playerText } : {}),
      ...(options?.length ? { options } : {}),
    });
  }

  beginTurn(): number {
    // As falas do turno eram sobre o que tinha acabado de acontecer: a próxima narração traz outras.
    for (const c of Object.values(this.state.characters)) {
      if (!c.lines) continue;
      c.lines.turn = [];
      c.lines.heard = 0;
      delete c.lines.initiative;
    }
    return ++this.state.turn;
  }

  defineRuleset(input: {
    name: string;
    attributes: AttributeInput[];
    resources: ResourceInput[];
    perks?: PerkInput[];
    conditions?: PerkInput[];
    dice?: string;
    difficulties?: Partial<Record<DifficultyName, number>>;
    notes?: string;
    era?: Era;
  }): Ruleset {
    if (Object.keys(this.state.characters).length) {
      throw new EngineError('As regras já estão em uso por personagens; para mudar no meio da campanha, use extend_ruleset.');
    }
    const dice = input.dice ?? DEFAULT_RULESET.dice;
    if (!parseDice(dice)) throw new EngineError(`Dados inválidos: "${dice}". Use o formato NdM, por exemplo 2d6.`);
    const difficulties = { ...DEFAULT_RULESET.difficulties, ...input.difficulties };
    const ladder = [difficulties.facil, difficulties.normal, difficulties.dificil, difficulties.muito_dificil];
    if (ladder.some((v, i) => i > 0 && v <= ladder[i - 1])) {
      throw new EngineError('As dificuldades precisam crescer: facil < normal < dificil < muito_dificil.');
    }
    const rules: Ruleset = {
      name: input.name,
      attributes: input.attributes.map((a) => this.attributeDef(a, 1)),
      resources: input.resources.map((r) => this.resourceDef(r)),
      perks: [],
      conditions: structuredClone(DEFAULT_CONDITIONS),
      speech: structuredClone(DEFAULT_SPEECH),
      senses: { ...DEFAULT_SENSES },
      sightChannels: [...DEFAULT_SIGHT_CHANNELS],
      vision: { ...DEFAULT_VISION },
      reaches: { ...DEFAULT_REACHES },
      dice,
      difficulties,
      notes: input.notes ?? DEFAULT_RULESET.notes,
    };
    const ids = [...rules.attributes, ...rules.resources].map((a) => a.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new EngineError(`Id repetido no ruleset: "${dup}".`);
    ensureCoreResources(rules);
    const previous = this.state.ruleset;
    this.state.ruleset = rules;
    try {
      for (const p of input.perks ?? []) rules.perks.push(this.perkDef(p));
      for (const p of input.conditions ?? []) rules.conditions.push(this.conditionDef(p));
    } catch (err) {
      this.state.ruleset = previous;
      throw err;
    }
    if (input.era) this.state.era = input.era;
    return rules;
  }

  /**
   * Regras que evoluem com a história: novos atributos (ex.: pontaria), recursos (ex.: infecção),
   * perks e condições, sentidos, visão e mudanças de visibilidade. Quem já existe recebe o valor padrão.
   */
  extendRuleset(input: {
    attributes?: AttributeInput[];
    resources?: ResourceInput[];
    perks?: PerkInput[];
    conditions?: PerkInput[];
    vision?: { clear?: number; dim?: number; dim_penalty?: number; blind_penalty?: number };
    sight_channels?: string[];
    visibility?: Record<string, Visibility>;
    speech_modes?: Record<string, SpeechMode>;
    senses?: Record<string, number>;
    reaches?: Record<string, number>;
    /** A história foi para outra época (viagem no tempo): os lugares novos e os itens novos seguem ela. */
    era?: Era;
    reason: string;
  }) {
    const rules = this.state.ruleset;
    const characters = Object.values(this.state.characters);
    const added: {
      kind: 'atributo' | 'recurso' | 'perk' | 'condição' | 'visibilidade' | 'modo de fala' | 'sentido' | 'alcance' | 'visão' | 'época';
      id: string;
      name: string;
      visibility?: Visibility;
    }[] = [];
    const tiles = (v: number, what: string) => {
      if (!Number.isFinite(v) || v < 0 || v > 200) throw new EngineError(`${what} precisa ficar entre 0 e 200.`);
      return Math.round(v * 10) / 10;
    };
    for (const [rawId, mode] of Object.entries(input.speech_modes ?? {})) {
      const id = slugify(rawId, 20);
      rules.speech[id] = {
        label: mode.label,
        reach: tiles(mode.reach, `O alcance de "${id}"`),
        channels: Object.fromEntries(Object.entries(mode.channels).map(([c, r]) => [slugify(c, 20), tiles(r, `O canal "${c}"`)])),
      };
      added.push({ kind: 'modo de fala', id, name: mode.label, visibility: 'hidden' });
    }
    for (const [channel, value] of Object.entries(input.senses ?? {})) {
      const id = slugify(channel, 20);
      rules.senses[id] = tiles(value, `O sentido "${id}"`);
      added.push({ kind: 'sentido', id, name: id, visibility: 'hidden' });
    }
    for (const channel of input.sight_channels ?? []) {
      const id = slugify(channel, 20);
      if (!rules.sightChannels.includes(id)) rules.sightChannels.push(id);
      added.push({ kind: 'sentido', id, name: `${id} (exige ver)`, visibility: 'hidden' });
    }
    if (input.vision) {
      const share = (v: number | undefined, fallback: number, what: string) => {
        if (v === undefined) return fallback;
        if (!(v >= 0 && v <= 1)) throw new EngineError(`vision.${what} precisa ficar entre 0 e 1.`);
        return v;
      };
      const penalty = (v: number | undefined, fallback: number) => (v === undefined ? fallback : clamp(Math.round(v), 0, 6));
      const v = input.vision;
      const next = {
        clear: share(v.clear, rules.vision.clear, 'clear'),
        dim: share(v.dim, rules.vision.dim, 'dim'),
        dimPenalty: penalty(v.dim_penalty, rules.vision.dimPenalty),
        blindPenalty: penalty(v.blind_penalty, rules.vision.blindPenalty),
      };
      if (next.dim > next.clear) throw new EngineError('vision.dim (vulto) precisa ser menor que vision.clear (nítido).');
      rules.vision = next;
      added.push({ kind: 'visão', id: 'vision', name: `nítido ≥ ${next.clear}, vulto ≥ ${next.dim}`, visibility: 'hidden' });
    }
    for (const [action, value] of Object.entries(input.reaches ?? {})) {
      const id = slugify(action, 24);
      rules.reaches[id] = tiles(value, `O alcance "${id}"`);
      added.push({ kind: 'alcance', id, name: id, visibility: 'hidden' });
    }
    for (const a of input.attributes ?? []) {
      const def = this.attributeDef(a, 0);
      this.assertNewStat(def.id);
      rules.attributes.push(def);
      for (const c of characters) c.attributes[def.id] = def.default;
      added.push({ kind: 'atributo', id: def.id, name: def.name, visibility: def.visibility });
    }
    for (const r of input.resources ?? []) {
      const def = this.resourceDef(r);
      this.assertNewStat(def.id);
      rules.resources.push(def);
      for (const c of characters) c.resources[def.id] = clamp(Math.round(r.start ?? def.max), 0, def.max);
      added.push({ kind: 'recurso', id: def.id, name: def.name, visibility: def.visibility });
    }
    for (const p of input.perks ?? []) {
      const def = this.perkDef(p);
      rules.perks.push(def);
      added.push({ kind: 'perk', id: def.id, name: def.name });
    }
    for (const p of input.conditions ?? []) {
      const def = this.conditionDef(p);
      rules.conditions.push(def);
      added.push({ kind: 'condição', id: def.id, name: def.name });
    }
    for (const [ref, visibility] of Object.entries(input.visibility ?? {})) {
      const def = this.findStatDef(ref);
      def.visibility = visibility;
      added.push({ kind: 'visibilidade', id: def.id, name: def.name, visibility });
    }
    if (input.era && input.era !== this.state.era) {
      this.state.era = input.era;
      added.push({ kind: 'época', id: input.era, name: ERAS.find((e) => e.id === input.era)!.label });
    }
    if (!added.length) {
      throw new EngineError(
        'Nada para estender: informe attributes, resources, perks, conditions, visibility, speech_modes, senses, sight_channels, vision, reaches ou era.',
      );
    }
    if (rules.attributes.length > 10 || rules.resources.length > 8) {
      throw new EngineError('Regras grandes demais (máx. 10 atributos e 8 recursos). Prefira perícias, que são livres.');
    }
    return { added, reason: input.reason };
  }

  private attributeDef(a: AttributeInput, fallbackDefault: number) {
    return {
      id: slugify(a.id ?? a.name, 20),
      name: a.name,
      description: a.description,
      visibility: a.visibility ?? 'self',
      default: clamp(Math.round(a.default ?? fallbackDefault), STAT_MIN, STAT_MAX),
    };
  }

  private resourceDef(r: ResourceInput): ResourceDef {
    if (!(r.max >= 1)) throw new EngineError(`O máximo de "${r.name}" precisa ser pelo menos 1.`);
    return { id: slugify(r.id ?? r.name, 20), name: r.name, max: Math.round(r.max), description: r.description, visibility: r.visibility ?? 'self' };
  }

  private assertNewStat(id: string): void {
    const rules = this.state.ruleset;
    if ([...rules.attributes, ...rules.resources].some((s) => s.id === id)) {
      throw new EngineError(`Já existe um atributo ou recurso com o id "${id}".`);
    }
  }

  /** Atributo ou recurso por id ou nome. */
  findStatDef(ref: string) {
    const rules = this.state.ruleset;
    const f = fold(ref);
    const def = [...rules.attributes, ...rules.resources].find((s) => s.id === slugify(ref, 20) || fold(s.name) === f);
    if (!def) {
      const known = [...rules.attributes, ...rules.resources].map((s) => s.id).join(', ');
      throw new EngineError(`"${ref}" não é atributo nem recurso das regras. Existentes: ${known}.`);
    }
    return def;
  }

  private perkDef(p: PerkInput): PerkDef {
    const id = slugify(p.id ?? p.name, 24);
    if (this.state.ruleset.perks.some((x) => x.id === id)) throw new EngineError(`Já existe um perk com o id "${id}".`);
    return { id, name: p.name, description: p.description, grants: p.grants.map((g) => this.grantDef(g, p.name)) };
  }

  private conditionDef(p: PerkInput): PerkDef {
    const id = slugify(p.id ?? p.name, 24);
    if (this.state.ruleset.conditions.some((x) => x.id === id)) throw new EngineError(`Já existe uma condição com o id "${id}".`);
    return { id, name: p.name, description: p.description, grants: p.grants.map((g) => this.grantDef(g, p.name)) };
  }

  private grantDef(g: PerkGrantInput, owner: string): PerkGrant {
    if (g.kind === 'see_stat') return { kind: 'see_stat', stat: this.findStatDef(g.stat).id };
    if (g.kind === 'sense') {
      if (g.multiplier === undefined && g.bonus === undefined && g.factor === undefined) {
        throw new EngineError(`"${owner}" precisa de multiplier, bonus ou factor no canal ${g.channel}.`);
      }
      return {
        kind: 'sense',
        channel: slugify(g.channel, 20),
        ...(g.multiplier !== undefined ? { multiplier: clamp(g.multiplier, 0, 20) } : {}),
        ...(g.bonus !== undefined ? { bonus: clamp(Math.round(g.bonus), -50, 200) } : {}),
        ...(g.factor !== undefined ? { factor: clamp(g.factor, 0, 5) } : {}),
      };
    }
    if (g.kind === 'check_bonus') {
      return {
        kind: 'check_bonus',
        bonus: clamp(Math.round(g.bonus), -5, 5),
        ...(g.attribute ? { attribute: this.resolveAttributeId(g.attribute) } : {}),
        ...(g.skill ? { skill: slugify(g.skill, 24) } : {}),
      };
    }
    if (g.kind === 'light') return { kind: 'light', ...lightSpec(g) };
    if (g.kind === 'conjure') {
      return {
        kind: 'conjure',
        ...(g.note ? { note: g.note } : {}),
        ...(g.cost ? { cost: { resource: this.resolveResourceId(g.cost.resource), amount: clamp(Math.round(g.cost.amount), 1, 100) } } : {}),
      };
    }
    return { kind: 'see_thoughts' };
  }

  private resolvePerkId(ref: string): string {
    const perk = this.state.ruleset.perks.find((p) => p.id === slugify(ref, 24) || fold(p.name) === fold(ref));
    if (!perk) {
      const known = this.state.ruleset.perks.map((p) => p.id).join(', ') || 'nenhum';
      throw new EngineError(`Perk "${ref}" não existe. Crie com extend_ruleset antes. Perks: ${known}.`);
    }
    return perk.id;
  }

  perksOf(c: Character): PerkDef[] {
    return c.perks.flatMap((id) => this.state.ruleset.perks.filter((p) => p.id === id));
  }

  private resolveConditionId(ref: string): string {
    const def = this.state.ruleset.conditions.find((d) => d.id === slugify(ref, 24) || fold(d.name) === fold(ref));
    if (!def) {
      const known = this.state.ruleset.conditions.map((d) => d.id).join(', ') || 'nenhuma';
      throw new EngineError(`Condição "${ref}" não existe. Crie com extend_ruleset (conditions) antes. Condições: ${known}.`);
    }
    return def.id;
  }

  conditionsOf(c: Character): PerkDef[] {
    return c.conditions.flatMap((a) => this.state.ruleset.conditions.filter((d) => d.id === a.id));
  }

  /** Perk (ou condição) com que o personagem tira itens do nada, se tiver. */
  conjurePerkOf(c: Character): PerkDef | null {
    return [...this.perksOf(c), ...this.conditionsOf(c)].find((p) => p.grants.some((g) => g.kind === 'conjure')) ?? null;
  }

  /**
   * O inventário do jogador é tudo o que ele tem: no meio do jogo, nada surge com ele, salvo por
   * um perk de conjurar, que pode cobrar um recurso a cada item.
   */
  private conjureFor(c: Character, what: string): PerkDef {
    const perk = this.conjurePerkOf(c);
    if (!perk) {
      throw new EngineError(
        `${what} não pode surgir com ${c.name}: o jogador só tem o que está no inventário dele. Se a ação dependia disso, ` +
          'ela falha; narre a tentativa frustrada. Se o objeto existe no mundo, crie onde ele está (com alguém, num móvel, ' +
          'no chão) e faça chegar até ele com transfer_item. Tirar coisas do nada só com um perk de conjurar (kind "conjure").',
      );
    }
    for (const g of perk.grants) {
      if (g.kind !== 'conjure' || !g.cost) continue;
      const max = this.state.ruleset.resources.find((r) => r.id === g.cost!.resource)?.max ?? 0;
      const have = c.resources[g.cost.resource] ?? max;
      if (have < g.cost.amount) {
        throw new EngineError(`${c.name} não tem ${g.cost.resource} para ${perk.name}: precisa de ${g.cost.amount} e tem ${have}.`);
      }
      c.resources[g.cost.resource] = have - g.cost.amount;
    }
    return perk;
  }

  /** Item criado agora com o jogador, no meio do jogo: só por perk de conjurar. */
  conjuredBy(item: Item): PerkDef | null {
    const { holder } = item;
    if (holder.kind !== 'character' || holder.id !== this.state.playerId || this.state.turn === 0) return null;
    return this.conjurePerkOf(this.state.characters[holder.id]);
  }

  /** "Cego (até 08:20)", para o mestre e a interface. */
  conditionLabels(c: Character): string[] {
    return c.conditions.map((a) => {
      const name = this.state.ruleset.conditions.find((d) => d.id === a.id)?.name ?? a.id;
      if (!a.until) return name;
      return `${name} (até ${a.until.day === this.state.clock.day ? hhmm(a.until.minutes) : formatClock(a.until)})`;
    });
  }

  createLocation(
    spec: Omit<LocationSpec, 'id' | 'layout' | 'legend'> & {
      id?: string;
      layout?: string | string[];
      template?: TemplateOptions & { name: TemplateName };
      exits?: ExitInput[];
      legend?: Record<string, string | ObjectTypeInput>;
      /** Época do lugar, se não for a da campanha (viagem no tempo, um museu de outra era). */
      era?: Era;
      walls?: WallMaterial;
      wall_color?: string;
      decor?: string[];
    },
  ): { location: Location; warnings: string[] } {
    if (!spec.layout && !spec.template) throw new EngineError('Informe layout (ASCII) ou template (saguao, corredor).');
    const era = spec.era ?? this.state.era;
    // Lugar fechado sem chão dito: o da época (pedra num castelo, metal numa nave).
    if (!spec.floor && !spec.outdoor && era) spec = { ...spec, floor: ERA_LOOK[era].floor };
    // Layout pronto: o motor desenha; as saídas já saem com nome (rua, elevador, apartamentos).
    const template = spec.template ? buildTemplate(spec.template.name, spec.template, () => randInt(this.state, 0, 999_999) / 1_000_000) : null;
    const legend = this.resolveLegend(spec.legend);
    const id = this.claimId(spec.id, spec.name, 'o local');
    const result = buildLocation({ ...spec, id, layout: template?.rows ?? spec.layout!, floor: spec.floor ?? template?.floor, legend });
    if (!result.ok) {
      throw new EngineError(
        `Layout inválido:\n- ${result.errors.join('\n- ')}${result.warnings.length ? `\nAvisos:\n- ${result.warnings.join('\n- ')}` : ''}`,
      );
    }
    this.state.locations[id] = result.location;
    if (template) {
      const exits = result.location.fixtures.filter((f) => result.location.exits[f.id]);
      exits.forEach((f, i) => (result.location.exits[f.id].label = template.label(f, i, exits)));
    }
    this.setExits(result.location, spec.exits ?? []);
    if (era) result.location.era = era;
    this.dress(result.location, spec, era);
    // Móvel de outra época sem visual desta: o 3D o mostra como é (uma geladeira no castelo).
    const odd = [...new Set(result.location.fixtures.map((f) => f.kind))].filter((k) => outOfEra(typeChain(this.state, k), era));
    if (odd.length) {
      result.warnings.push(
        `Sem visual da época (${era}): ${odd.map((k) => objectType(this.state, k).label).join(', ')} aparece como é hoje. Se não existe nessa ` +
          'época, troque por um tipo dela; se existe, defina o tipo na legenda com model (busque com search_models).',
      );
    }
    return { location: result.location, warnings: result.warnings };
  }

  /**
   * A aparência de um lugar fechado: o material e a cor das paredes e o que as enfeita. O que o
   * mestre não diz vem da época (o castelo de pedra com tapeçarias e tochas); sem época, como antes.
   */
  private dress(loc: Location, spec: { walls?: WallMaterial; wall_color?: string; decor?: string[] }, era: Era | undefined): void {
    if (spec.wall_color !== undefined && !/^#[0-9a-f]{6}$/i.test(spec.wall_color)) {
      throw new EngineError(`wall_color precisa ser uma cor #rrggbb (veio "${spec.wall_color}").`);
    }
    if (loc.outdoor) return;
    const look = era ? ERA_LOOK[era] : null;
    const material = spec.walls ?? look?.walls;
    if (material) loc.walls = { material, ...(spec.wall_color ? { color: spec.wall_color.toLowerCase() } : {}) };
    const decor = spec.decor ?? look?.decor;
    if (decor) loc.decor = [...new Set(decor.filter((d) => DECOR_IDS.includes(d)))];
  }

  /** Época de onde algo está: a do lugar, ou a da campanha (com alguém fora de cena). */
  eraAt(holder: ItemHolder): Era | undefined {
    const place = this.holderPlace(holder);
    return (place && this.state.locations[place.locationId]?.era) ?? this.state.era;
  }

  /**
   * Visual de personagem de outra época que a campanha: vale (um viajante do tempo), mas o mestre
   * fica sabendo. Os da lista padrão, sem pacote, são de hoje.
   */
  lookEraNote(c: Character): string | null {
    const era = this.state.era;
    if (!era || !c.look) return null;
    const own = c.look.includes(':') ? PACK_ERA[c.look.split(':')[0]] : 'atual';
    if (!own || own === era) return null;
    return `${c.name}: o visual ${c.look} é de outra época (${own}) e a campanha é ${era}. Se não for de propósito, troque com update_character look por um da época.`;
  }

  /** O tipo de um objeto: da biblioteca ou criado nesta campanha. */
  typeOf(kind: string): ObjectType {
    return objectType(this.state, kind);
  }

  /**
   * Legenda extra de um local: cada caractere aponta para um tipo da biblioteca (pelo id ou pelo
   * nome) ou define um tipo novo, que herda do parecido (like) o que não for informado.
   */
  private resolveLegend(input: Record<string, string | ObjectTypeInput> | undefined): Record<string, TileDef> {
    const legend: Record<string, TileDef> = {};
    for (const [char, ref] of Object.entries(input ?? {})) {
      if ([...char].length !== 1) throw new EngineError(`"${char}" na legenda: use um caractere por tipo de objeto.`);
      if (LEGEND[char]) throw new EngineError(`'${char}' já é ${LEGEND[char].label} na legenda fixa; escolha outro caractere para ${typeof ref === 'string' ? ref : ref.label}.`);
      legend[char] = tileOf(typeof ref === 'string' ? this.findType(ref) : this.defineType(ref), char);
    }
    return legend;
  }

  private findType(ref: string): ObjectType {
    const t = findObjectType(this.state, ref);
    if (!t) {
      throw new EngineError(
        `"${ref}" não é um tipo de objeto conhecido. Use um da biblioteca (${librarySummary()}) ou defina um novo na legenda: ` +
          `{"label": "${ref}", "like": "<tipo parecido>"}.`,
      );
    }
    return t;
  }

  /** Tipo novo do mestre; um que já existe com o mesmo nome é reaproveitado, para o mundo ficar coerente. */
  private defineType(input: ObjectTypeInput): ObjectType {
    const existing = findObjectType(this.state, input.label);
    if (existing) return existing;
    if (input.model) this.catalogModel(input.model, 'type');
    const { like, ...own } = input;
    const t = resolveType(like ? this.findType(like) : null, own);
    this.state.objectTypes[t.id] = t;
    return t;
  }

  /**
   * Modelo do catálogo 3D que o mestre escolheu, conferido: um tipo de objeto não usa personagem, e
   * o visual de um personagem precisa ser um. Sem o catálogo nesta máquina, vale o que veio (o 3D
   * usa o parecido ou o corpo).
   */
  private catalogModel(id: string, use: 'type' | 'look' | 'item'): CatalogItem | null {
    const catalog = modelCatalog();
    if (!catalog) return null;
    const item = catalog.get(id);
    if (!item || item.sensivel) throw new EngineError(`"${id}" não é um modelo do catálogo. Busque com search_models e use o id que ela devolve.`);
    if (use === 'look' && item.category !== 'personagem') {
      throw new EngineError(`"${id}" é ${item.category}, não personagem: o visual (look) precisa ser um personagem do catálogo.`);
    }
    if (use !== 'look' && item.category === 'personagem') throw new EngineError(`"${id}" é um personagem: gente entra com create_characters e look.`);
    if (use === 'item' && !portable(item)) {
      throw new EngineError(
        `"${id}" (${item.desc ?? item.category}${item.size ? `, ${sizeLabel(item.size)}` : ''}) não cabe na mão de ninguém, e item é o que se carrega. ` +
          'Busque um menor com search_models (ela mostra o tamanho); se a coisa não se carrega mesmo, faça dela um móvel na legenda do local.',
      );
    }
    return item;
  }

  /** Dá destino e nome às saídas (porta, elevador, escada) de um local. */
  private setExits(loc: Location, specs: ExitInput[]): void {
    for (const spec of specs) {
      const f = this.exitFixture(loc, spec.fixture);
      if (spec.to !== undefined) {
        if (spec.to) this.link(loc, f, slugify(spec.to, 24));
        else loc.exits[f.id].to = [];
      }
      if (spec.label) loc.exits[f.id].label = spec.label;
    }
  }

  /** A porta passa a levar só a `to`; elevador e escada ganham mais um andar. */
  private link(loc: Location, f: Fixture, to: string): void {
    const exit = loc.exits[f.id];
    if (f.exit !== 'floors') exit.to = [to];
    else if (!exit.to.includes(to)) exit.to.push(to);
  }

  private exitFixture(loc: Location, ref: string): Fixture {
    const f = loc.fixtures.find((x) => x.id === ref || x.id === `${loc.id}/${ref}`);
    if (!f || !loc.exits[f.id]) {
      const known = Object.keys(loc.exits).map((id) => id.slice(loc.id.length + 1)).join(', ') || 'nenhuma';
      throw new EngineError(`"${ref}" não é uma saída de ${loc.name}. Saídas: ${known}.`);
    }
    return f;
  }

  /**
   * A saída por onde o personagem deixa o local: a indicada (via), a que já leva ao destino ou a
   * única ainda sem destino. Porta leva a um lugar só; elevador e escada, a qualquer andar. Local
   * sem saída nenhuma (área aberta) não exige.
   */
  private exitTowards(loc: Location, targetId: string, via: string | undefined): Fixture | null {
    const exits = Object.entries(loc.exits);
    if (!exits.length) return null;
    if (via) {
      const f = this.exitFixture(loc, via);
      const [to] = loc.exits[f.id].to;
      if (f.exit !== 'floors' && to && to !== targetId) {
        throw new EngineError(`${f.id.slice(loc.id.length + 1)} leva a ${this.state.locations[to]?.name ?? to}, não a ${this.findLocation(targetId).name}.`);
      }
      return f;
    }
    const linked = exits.find(([, e]) => e.to.includes(targetId));
    if (linked) return this.findFixture(linked[0]);
    const free = exits.filter(([, e]) => !e.to.length);
    if (free.length === 1) return this.findFixture(free[0][0]);
    const list = exits.map(([id, e]) => `${id.slice(loc.id.length + 1)} (${e.label}${e.to.length ? ` → ${e.to.join(', ')}` : ''})`).join(', ');
    throw new EngineError(`Por onde ele sai de ${loc.name}? Informe via com uma das saídas: ${list}.`);
  }

  /**
   * Onde o personagem chega: quem pega o elevador sai de um elevador (a escada, de uma escada); quem
   * passa por uma porta chega pela que leva de volta ou por uma ainda livre.
   */
  private arrivalExit(loc: Location, fromId: string, used: Fixture | null): Fixture | null {
    const kind = used?.kind ?? null;
    const exits = Object.entries(loc.exits).map(([id, e]) => ({ f: this.findFixture(id), to: e.to }));
    const back = exits.filter((x) => x.to.includes(fromId));
    const free = exits.filter((x) => !x.to.length);
    const same = used?.exit === 'floors' ? exits.filter((x) => x.f.kind === kind) : [];
    const pick =
      back.find((x) => x.f.kind === kind) ??
      same.find((x) => !x.to.length) ??
      same[0] ??
      back[0] ??
      free.find((x) => x.f.kind === kind) ??
      free.find((x) => x.f.exit === 'door') ??
      free[0];
    return pick?.f ?? null;
  }

  /** Luz ambiente (acender ou apagar as luzes, anoitecer), nome e descrição de um local. */
  updateLocation(input: {
    location_id: string;
    light?: number;
    name?: string;
    description?: string;
    exits?: ExitInput[];
    walls?: WallMaterial;
    wall_color?: string;
    floor?: FloorStyle;
    decor?: string[];
  }) {
    const loc = this.findLocation(input.location_id);
    const before = loc.light;
    const look = input.walls !== undefined || input.wall_color !== undefined || input.floor !== undefined || input.decor !== undefined;
    if (input.light === undefined && input.name === undefined && input.description === undefined && !input.exits?.length && !look) {
      throw new EngineError('Nada para mudar: informe light, name, description, exits ou a aparência (walls, wall_color, floor, decor).');
    }
    if (look) {
      // Reforma: o que não muda fica como estava.
      this.dress(loc, { walls: input.walls ?? loc.walls?.material ?? 'reboco', wall_color: input.wall_color ?? loc.walls?.color, decor: input.decor ?? loc.decor }, undefined);
      if (input.floor) loc.floor = input.floor;
    }
    this.setExits(loc, input.exits ?? []);
    if (input.light !== undefined) {
      if (!(input.light >= 0 && input.light <= 1)) throw new EngineError('light vai de 0 (breu) a 1 (dia claro ou luzes acesas).');
      loc.light = Math.round(input.light * 100) / 100;
    }
    if (input.name) loc.name = input.name;
    if (input.description !== undefined) loc.description = input.description;
    return { location_id: loc.id, name: loc.name, light: { before, after: loc.light }, exits: loc.exits };
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
    // Visual do catálogo (pacote:Arquivo): sem corpo informado, vale o do modelo.
    const model = input.look?.includes(':') ? this.catalogModel(input.look, 'look') : null;
    const figure = input.figure ?? (FIGURES.has(model?.figure ?? '') ? (model!.figure as Figure) : undefined);
    // Primeiro nome, pulando títulos abreviados ("Prof. Tanaka" → tanaka).
    const firstName = input.name.split(/\s+/).find((w) => w && !w.endsWith('.')) ?? input.name;
    const id = this.claimId(input.id, firstName, input.name);
    const rules = this.state.ruleset;
    const attributes = Object.fromEntries(rules.attributes.map((a) => [a.id, a.default]));
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
      ...(figure ? { figure } : {}),
      ...(input.look ? { look: input.look } : {}),
      ...(input.seen_as ? { seenAs: input.seen_as } : {}),
      traits: input.traits ?? [],
      attributes,
      skills: this.statBlock('perícia', input.skills, null),
      resources,
      perks: [...new Set((input.perks ?? []).map((p) => this.resolvePerkId(p)))],
      conditions: [],
      thoughts: input.thoughts ?? null,
      detail: input.personality || input.background ? 'full' : 'sketch',
      personality: input.personality ?? null,
      background: input.background ?? null,
      goals: input.goals ?? null,
      locationId: null,
      pos: null,
      facing: 'S',
      seatId: null,
      knows: [],
      voices: {},
      feelings: {},
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

  moveCharacter(input: { character_id: string; to: Placement & { location_id?: string }; via?: string; face?: string }) {
    const c = this.findCharacter(input.character_id);
    const targetLoc = input.to.location_id ? this.findLocation(input.to.location_id) : c.locationId ? this.state.locations[c.locationId] : null;
    if (!targetLoc) throw new EngineError(`${c.name} não está em nenhum local; informe to.location_id.`);
    const changing = targetLoc.id !== c.locationId;
    const hasSpot = input.to.x !== undefined || input.to.y !== undefined || input.to.seat || input.to.near;
    const from = c.pos ? { location: c.locationId, x: c.pos.x, y: c.pos.y, seat: c.seatId } : null;
    let path: Pos[] | null = null;
    let spot: { pos: Pos; seatId: string | null };
    let exitUsed: Fixture | null = null;
    let arrival: Fixture | null = null;
    if (changing) {
      // Sai por uma porta, elevador ou escada: quem está num local não muda de local do nada.
      const fromLoc = c.locationId ? this.state.locations[c.locationId] : null;
      if (fromLoc && c.pos) {
        exitUsed = this.exitTowards(fromLoc, targetLoc.id, input.via);
        if (exitUsed) {
          const goal = this.nearestFreeAround(fromLoc, exitUsed, c.pos, c.id);
          if (goal && !this.findPath(fromLoc, c.pos, goal, c.id)) {
            throw new EngineError(`${c.name} não tem caminho até ${exitUsed.label} (${exitUsed.id.slice(fromLoc.id.length + 1)}).`);
          }
          this.link(fromLoc, exitUsed, targetLoc.id);
        }
      }
      if (fromLoc) arrival = this.arrivalExit(targetLoc, fromLoc.id, exitUsed);
      if (arrival && fromLoc) this.link(targetLoc, arrival, fromLoc.id);
      if (hasSpot) spot = this.resolvePlacement(targetLoc, input.to, c.id, null);
      else {
        const p = arrival ? this.nearestFreeAround(targetLoc, arrival, null, c.id) : this.entrance(targetLoc);
        if (!p) throw new EngineError(`Não há espaço livre em ${targetLoc.name}.`);
        spot = { pos: p, seatId: null };
      }
    } else {
      if (!hasSpot) throw new EngineError('Informe o destino: {x, y}, {seat}, {near} ou {location_id} de outro local.');
      spot = this.resolvePlacement(targetLoc, input.to, c.id, c.pos);
      if (c.pos) {
        path = this.findPath(targetLoc, c.pos, spot.pos, c.id);
        if (!path) throw new EngineError(`${c.name} não tem caminho de (${c.pos.x},${c.pos.y}) até (${spot.pos.x},${spot.pos.y}).`);
      }
    }
    // Quem muda de local deixa para trás as vozes que ouviu, e os outros perdem a dele.
    if (changing) {
      c.voices = {};
      for (const o of Object.values(this.state.characters)) delete o.voices[c.id];
    }
    // Quem sai do lugar desfaz a pose (o ajoelhado se levanta para andar).
    if (changing || !c.pos || c.pos.x !== spot.pos.x || c.pos.y !== spot.pos.y || c.seatId !== spot.seatId) {
      c.pose = null;
      c.poseTarget = null;
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
      ...(exitUsed ? { via: exitUsed.id } : {}),
      ...(arrival ? { arrived_by: arrival.id } : {}),
      steps: path ? path.length - 1 : null,
      facing: c.facing,
      path: path ?? undefined,
    };
  }

  /**
   * Grafo de conhecidos: todos do group passam a se conhecer; com who e knows, cada um de who
   * passa a conhecer cada um de knows (e o contrário, salvo mutual false). Conhecer é saber o nome
   * e reconhecer o rosto e a voz.
   */
  introduce(input: { group?: string[]; who?: string[]; knows?: string[]; mutual?: boolean }) {
    const group = (input.group ?? []).map((ref) => this.findCharacter(ref));
    const who = (input.who ?? []).map((ref) => this.findCharacter(ref));
    const known = (input.knows ?? []).map((ref) => this.findCharacter(ref));
    if (group.length < 2 && !(who.length && known.length)) throw new EngineError('Informe group (duas pessoas ou mais) ou who e knows.');
    const pairs: [Character, Character][] = group.flatMap((a) => group.map((b): [Character, Character] => [a, b]));
    for (const a of who) {
      for (const b of known) pairs.push([a, b], ...(input.mutual === false ? [] : [[b, a] as [Character, Character]]));
    }
    const added: { who: string; knows: string }[] = [];
    for (const [a, b] of pairs) {
      if (a.id === b.id || a.knows.includes(b.id)) continue;
      a.knows.push(b.id);
      added.push({ who: a.id, knows: b.id });
    }
    return { added };
  }

  /**
   * O que um NPC sente por alguém: grau de -3 a +3 (a boa vontade com a pessoa) e o porquê.
   * Grau 0 sem texto apaga. O que o personagem do jogador sente, quem diz é o jogador.
   */
  setFeelings(entries: { who: string; toward: string; degree: number; text: string }[]) {
    const changed: { who: string; toward: string; degree: number; before: number | null }[] = [];
    for (const entry of entries) {
      const c = this.findCharacter(entry.who);
      const t = this.findCharacter(entry.toward);
      if (c.isPlayer) throw new EngineError(`O que ${c.name} sente, quem diz é o jogador: registre só o que os NPCs sentem.`);
      if (c.id === t.id) throw new EngineError(`${c.name} não pode sentir algo por si mesmo aqui: isso vai em personality ou thoughts.`);
      const degree = Math.round(entry.degree);
      if (!(degree >= -3 && degree <= 3)) throw new EngineError(`O grau vai de -3 a +3 (veio ${entry.degree}).`);
      const text = entry.text.trim();
      const before = c.feelings[t.id]?.degree ?? null;
      if (degree === 0 && !text) delete c.feelings[t.id];
      else c.feelings[t.id] = { degree, text };
      changed.push({ who: c.id, toward: t.id, degree, before });
    }
    return { changed };
  }

  /**
   * Falas prontas dos NPCs: as listas que vierem substituem as de antes, e o rodízio recomeça. A
   * fala que conta um fato precisa ser de quem sabe; a iniciativa vale até o próximo turno do mestre.
   */
  setLines(entries: { who: string; turn?: LineInput[]; general?: LineInput[]; initiative?: 'vem' | 'chama' | 'nenhuma' }[]) {
    const changed: { who: string; turn: number; general: number; initiative?: string }[] = [];
    const clean = (c: Character, list: LineInput[] | undefined): ReadyLine[] | undefined =>
      list
        ?.map((l) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }))
        .filter((l) => l.text)
        .map((l) => {
          if (/^@|\{[a-z0-9_]+:/i.test(l.text)) throw new EngineError(`Fala pronta de ${c.name} com marca: escreva só o que a pessoa diz, sem @id nem {gesto}.`);
          const fact = l.fact_id ? this.findFact(l.fact_id) : null;
          if (fact && !this.knows(c.id, fact)) {
            throw new EngineError(`${c.name} não sabe ${fact.id}, então não pode contar numa fala pronta. Dê a fala a quem sabe, ou registre antes como ele soube.`);
          }
          return { text: l.text, ...(fact ? { fact: fact.id } : {}), ...(l.introduces ? { introduces: true } : {}), ...(l.whisper ? { whisper: true } : {}) };
        });
    for (const entry of entries) {
      const c = this.findCharacter(entry.who);
      if (c.isPlayer) throw new EngineError(`O que ${c.name} diz, quem decide é o jogador: falas prontas são dos NPCs.`);
      const lines = (c.lines ??= { turn: [], general: [], heard: 0 });
      lines.turn = clean(c, entry.turn) ?? lines.turn;
      lines.general = clean(c, entry.general) ?? lines.general;
      lines.heard = 0;
      if (entry.initiative === 'nenhuma') delete lines.initiative;
      else if (entry.initiative) lines.initiative = entry.initiative;
      changed.push({ who: c.id, turn: lines.turn.length, general: lines.general.length, ...(lines.initiative ? { initiative: lines.initiative } : {}) });
    }
    return { changed };
  }

  /** Depois da narração: quem ouviu um conhecido falar passa a saber quem é, mesmo no escuro. */
  hearVoices(lines: { speakerId: string; hearers: string[] }[]): void {
    hearVoices(this.state, lines);
  }

  updateCharacter(input: CharacterUpdate) {
    const c = this.findCharacter(input.character_id);
    if (input.look?.includes(':')) this.catalogModel(input.look, 'look');
    const changes: string[] = [];
    for (const key of ['name', 'role', 'appearance', 'look', 'personality', 'background', 'goals'] as const) {
      const value = input[key];
      if (value !== undefined && value !== c[key]) {
        c[key] = value;
        changes.push(key);
      }
    }
    if (input.figure !== undefined && input.figure !== c.figure) {
      c.figure = input.figure;
      changes.push('figure');
    }
    if (input.seen_as !== undefined && input.seen_as !== c.seenAs) {
      c.seenAs = input.seen_as;
      changes.push('seen_as');
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
    const attributeChanges: string[] = [];
    if (input.attributes) {
      const values = this.statBlock('atributo', input.attributes, this.state.ruleset.attributes.map((a) => a.id));
      Object.assign(c.attributes, values);
      attributeChanges.push(...Object.keys(values));
    }
    if (input.skills) {
      for (const [key, value] of Object.entries(this.statBlock('perícia', input.skills, null))) {
        if (value === 0) delete c.skills[key];
        else c.skills[key] = value;
      }
      changes.push('skills');
    }
    if (input.perks_add?.length) {
      for (const id of input.perks_add.map((p) => this.resolvePerkId(p))) if (!c.perks.includes(id)) c.perks.push(id);
      changes.push('perks');
    }
    if (input.perks_remove?.length) {
      const remove = new Set(input.perks_remove.map((p) => this.resolvePerkId(p)));
      c.perks = c.perks.filter((id) => !remove.has(id));
      changes.push('perks');
    }
    for (const entry of input.conditions_add ?? []) {
      const { id: ref, minutes } = typeof entry === 'string' ? { id: entry, minutes: undefined } : entry;
      const id = this.resolveConditionId(ref);
      if (minutes !== undefined && !(minutes >= 1 && minutes <= 525600)) throw new EngineError('minutes da condição vai de 1 a 525600 (um ano).');
      const until = minutes === undefined ? null : addMinutes(this.state.clock, Math.round(minutes));
      c.conditions = [...c.conditions.filter((x) => x.id !== id), { id, until }];
      changes.push('conditions');
    }
    if (input.conditions_remove?.length) {
      const remove = new Set(input.conditions_remove.map((x) => this.resolveConditionId(x)));
      c.conditions = c.conditions.filter((x) => !remove.has(x.id));
      changes.push('conditions');
    }
    if (input.thoughts !== undefined) {
      c.thoughts = input.thoughts.trim() || null;
      changes.push('thoughts');
    }
    let stoodUp: { from: string; label: string; x: number; y: number } | null = null;
    if (input.pose !== undefined) {
      if (!POSES[input.pose]) throw new EngineError(`A pose "${input.pose}" não existe. Poses: ${POSE_IDS.join(', ')}.`);
      // Pose que não se faz num assento (de pé, ajoelhado, em guarda) levanta quem está nele: a
      // pessoa sai para o lado do móvel, como quem se levanta da cama.
      if (c.seatId && !POSES[input.pose].seated) {
        const seat = this.findFixture(c.seatId);
        const moved = this.moveCharacter({ character_id: c.id, to: { near: seat.id } });
        const of = objectType(this.state, seat.kind).article === 'o' ? 'do' : 'da';
        stoodUp = { from: seat.id, label: `${of} ${seat.label}`, x: moved.to.x, y: moved.to.y };
        changes.push('pose');
      }
      const pose = input.pose === 'de_pe' ? null : input.pose;
      // Pose nova sem alvo solta o alvo da anterior.
      const target = input.pose_target === undefined ? null : this.poseTarget(c, input.pose_target);
      if (pose !== (c.pose ?? null) || target !== (c.poseTarget ?? null)) changes.push('pose');
      c.pose = pose;
      c.poseTarget = target;
    } else if (input.pose_target !== undefined) {
      c.poseTarget = this.poseTarget(c, input.pose_target);
      changes.push('pose');
    }
    const resourceChanges: { id: string; before: number; after: number; max: number }[] = [];
    const applyResource = (key: string, next: (cur: number) => number) => {
      const rid = this.resolveResourceId(key);
      const max = this.state.ruleset.resources.find((r) => r.id === rid)!.max;
      const before = c.resources[rid] ?? max;
      c.resources[rid] = clamp(Math.round(next(before)), 0, max);
      resourceChanges.push({ id: rid, before, after: c.resources[rid], max });
    };
    for (const [key, value] of Object.entries(input.resources_set ?? {})) applyResource(key, () => value);
    for (const [key, delta] of Object.entries(input.resource_deltas ?? {})) applyResource(key, (cur) => cur + delta);
    if (c.personality || c.background) c.detail = 'full';
    return {
      character_id: c.id,
      changed: [...new Set(changes)],
      attributes: attributeChanges,
      resources: resourceChanges,
      detail: c.detail,
      ...(stoodUp ? { stood_up: stoodUp } : {}),
    };
  }

  /** Alvo de uma pose: alguém ou algo no mesmo local; vazio tira. */
  private poseTarget(c: Character, ref: string): string | null {
    const id = ref.trim();
    if (!id) return null;
    const other = this.state.characters[id.toLowerCase()];
    if (other) {
      if (other.locationId !== c.locationId) throw new EngineError(`${other.name} não está no mesmo local que ${c.name}.`);
      return other.id;
    }
    return this.findFixture(id, c.locationId).id;
  }

  private resolveHolder(ref: HolderRef, fallbackLocationId: string | null): ItemHolder {
    const modes = [ref.character_id, ref.fixture_id, ref.x !== undefined || ref.y !== undefined].filter(Boolean).length;
    if (modes !== 1) throw new EngineError('Informe exatamente um destino: {character_id}, {fixture_id} ou {x, y} (+ location_id).');
    if (ref.hand && !ref.character_id) throw new EngineError('hand só vale com character_id: é a mão de alguém.');
    if (ref.character_id) return { kind: 'character', id: this.findCharacter(ref.character_id).id, ...(ref.hand ? { hand: ref.hand } : {}) };
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

  /**
   * Põe o item na mão certa para o jeito de empunhar; o que ocupava essa mão (ou as duas, numa
   * arma de duas mãos) volta a ficar guardado com a pessoa. Devolve os nomes do que foi guardado.
   */
  private wield(item: Item, holder: ItemHolder): string[] {
    if (holder.kind !== 'character' || !holder.hand) return [];
    holder.hand = handFor(item, holder.hand);
    const both = GRIPS[gripOf(item)].both;
    const stowed: string[] = [];
    for (const other of Object.values(this.state.items)) {
      const h = other.holder;
      if (other.id === item.id || h.kind !== 'character' || h.id !== holder.id || !h.hand) continue;
      if (both || GRIPS[gripOf(other)].both || h.hand === holder.hand) {
        delete h.hand;
        stowed.push(other.name);
      }
    }
    return stowed;
  }

  private checkGrip(grip: string | undefined): Item['grip'] {
    if (grip === undefined) return undefined;
    if (!GRIP_IDS.includes(grip as Grip)) throw new EngineError(`grip "${grip}" não existe. Opções: ${GRIP_IDS.join(', ')}.`);
    return grip as Grip;
  }

  createItem(input: {
    id?: string;
    name: string;
    description: string;
    tags?: string[];
    quantity?: number;
    holder: HolderRef;
    light?: LightInput;
    model?: string;
    grip?: string;
    text?: string;
    written_by?: string;
  }): Item {
    const holder = this.resolveHolder(input.holder, this.currentLocation?.id ?? null);
    if (input.model) this.catalogModel(input.model, 'item');
    const grip = this.checkGrip(input.grip);
    const author = input.written_by ? this.findCharacter(input.written_by).id : null;
    // Sem modelo, o mais parecido do catálogo pelo nome e pela descrição: um item sem visual é uma
    // caixinha no 3D. O mestre vê qual foi e troca se não combinar.
    const model = input.model ?? modelCatalog()?.suggest(input.name, input.description, 1, this.eraAt(holder))[0]?.id;
    if (holder.kind === 'character' && holder.id === this.state.playerId && this.state.turn > 0) {
      this.conjureFor(this.state.characters[holder.id], `"${input.name}"`);
    }
    const quantity = Math.max(1, Math.round(input.quantity ?? 1));
    const item: Item = {
      id: this.claimId(input.id, input.name, input.name),
      name: input.name,
      description: input.description,
      tags: input.tags ?? [],
      quantity,
      holder,
      ...(input.light ? { light: { ...lightSpec(input.light), on: input.light.on ?? false } } : {}),
      ...(model ? { model } : {}),
      ...(grip ? { grip } : {}),
    };
    this.wield(item, holder);
    this.state.items[item.id] = item;
    if (input.text !== undefined) this.writeText(item, input.text, author);
    return item;
  }

  /**
   * O que está escrito num item vira um fato com id, que quem escreveu sabe. Texto vazio marca um
   * texto ainda não lido: a primeira leitura na narração define o conteúdo. Reescrever cria outro
   * fato: quem leu a versão antiga continua sabendo só dela.
   */
  writeText(item: Item, text: string, authorId: string | null): Fact | null {
    const content = text.trim();
    if (!content) {
      if (item.text === undefined) item.text = null;
      return null;
    }
    if (content === item.text) return item.textFact ? (this.state.facts.find((f) => f.id === item.textFact) ?? null) : null;
    const fact = this.addFact({ subject: item.id, text: `${item.name}: «${content}»`, known_by: authorId ? [authorId] : [] });
    item.text = content;
    item.textFact = fact.id;
    return fact;
  }

  /** Alguém leu o texto do item: passa a saber o fato. Devolve se aprendeu agora. */
  readText(item: Item, readerId: string): boolean {
    const fact = item.textFact ? this.state.facts.find((f) => f.id === item.textFact) : undefined;
    if (!fact || fact.knownBy === 'all' || fact.knownBy.includes(readerId)) return false;
    fact.knownBy = [...fact.knownBy, readerId];
    return true;
  }

  transferItem(input: { item_id: string; to: HolderRef; quantity?: number; thrown?: boolean }) {
    const item = this.findItem(input.item_id);
    const fallbackLoc = this.holderPlace(item.holder)?.locationId ?? this.currentLocation?.id ?? null;
    const holder = this.resolveHolder(input.to, fallbackLoc);
    if (holder.kind === 'character' && holder.hand) holder.hand = handFor(item, holder.hand);
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
    const stowed = this.wield(moved, holder);
    return { item_id: moved.id, name: moved.name, quantity: qty, from, to: this.describeHolder(holder), ...(stowed.length ? { stowed } : {}) };
  }

  updateItem(input: {
    item_id: string;
    name?: string;
    description?: string;
    tags?: string[];
    quantity_delta?: number;
    destroy?: boolean;
    light?: LightInput | null;
    light_on?: boolean;
    model?: string;
    grip?: string;
    text?: string;
    written_by?: string;
  }) {
    const item = this.findItem(input.item_id);
    if (input.text !== undefined) this.writeText(item, input.text, input.written_by ? this.findCharacter(input.written_by).id : null);
    if (input.name) item.name = input.name;
    if (input.description) item.description = input.description;
    if (input.tags) item.tags = input.tags;
    if (input.model) {
      this.catalogModel(input.model, 'item');
      item.model = input.model;
    }
    if (input.grip) {
      item.grip = this.checkGrip(input.grip);
      // Com outro jeito de empunhar, a mão pode mudar (o arco vai para a esquerda).
      if (item.holder.kind === 'character' && item.holder.hand) this.wield(item, item.holder);
    }
    const holder = item.holder;
    if ((input.quantity_delta ?? 0) > 0 && holder.kind === 'character' && holder.id === this.state.playerId && this.state.turn > 0) {
      this.conjureFor(this.state.characters[holder.id], `Mais ${item.name}`);
    }
    if (input.light === null) delete item.light;
    else if (input.light) item.light = { ...lightSpec(input.light), on: input.light.on ?? item.light?.on ?? false };
    if (input.light_on !== undefined) {
      if (!item.light) throw new EngineError(`${item.name} não ilumina; para virar uma luz, informe light {radius, intensity}.`);
      item.light.on = input.light_on;
    }
    if (input.quantity_delta) item.quantity += Math.round(input.quantity_delta);
    if (input.destroy || item.quantity <= 0) {
      delete this.state.items[item.id];
      return { item_id: item.id, destroyed: true };
    }
    return { item_id: item.id, destroyed: false, quantity: item.quantity, name: item.name, light: item.light ?? null };
  }

  updateFixture(input: { fixture_id: string; text?: string; append_text?: string; state?: string }) {
    const f = this.findFixture(input.fixture_id);
    if (input.text !== undefined) f.text = input.text;
    if (input.append_text) f.text = f.text ? `${f.text}\n${input.append_text}` : input.append_text;
    if (input.state !== undefined) f.state = input.state;
    if (f.text.length > 600) throw new EngineError('O texto do móvel passou de 600 caracteres; apague parte antes (text).');
    return { fixture_id: f.id, text: f.text, state: f.state };
  }

  /** Alcance de uma ação com alvo: um número de tiles ou uma chave de ruleset.reaches. */
  private resolveReach(reach: string | number | undefined): { name: string; tiles: number } {
    const reaches = this.state.ruleset.reaches;
    if (typeof reach === 'number') return { name: `${reach} tiles`, tiles: reach };
    const key = reach === undefined ? 'visao' : slugify(reach, 24);
    if (reaches[key] === undefined) {
      throw new EngineError(`Alcance "${reach}" não existe. Alcances: ${Object.entries(reaches).map(([k, v]) => `${k} (${v})`).join(', ')}; crie com extend_ruleset.`);
    }
    return { name: key, tiles: reaches[key] };
  }

  skillCheck(input: {
    character_id: string;
    attribute: string;
    skill?: string;
    difficulty: DifficultyName | number;
    modifier?: number;
    reason: string;
    target_id?: string;
    reach?: string | number;
    needs_sight?: boolean;
    goodwill?: boolean;
  }) {
    const c = this.findCharacter(input.character_id);
    if (input.goodwill && !input.target_id) throw new EngineError('goodwill precisa de target_id: é a boa vontade do alvo com quem tenta.');
    let opponent: { id: string; name: string; distance: number; reach: string; sight: Sight } | null = null;
    if (input.target_id) {
      const t = this.findCharacter(input.target_id);
      const reach = this.resolveReach(input.reach);
      const d = c.pos && t.pos && c.locationId === t.locationId ? chebyshev(c.pos, t.pos) : null;
      if (d === null) throw new EngineError(`${c.name} e ${t.name} não estão no mesmo local.`);
      if (d > reach.tiles) {
        throw new EngineError(
          `${t.name} está a ${d} tiles de ${c.name}, e "${reach.name}" alcança ${reach.tiles}. ` +
            'Aproxime os dois com move_character antes, ou escolha uma ação de alcance maior.',
        );
      }
      opponent = { id: t.id, name: t.name, distance: d, reach: reach.name, sight: sightOf(this.state, c.id, t.id) };
    }
    const attrId = this.resolveAttributeId(input.attribute);
    const attr = this.state.ruleset.attributes.find((a) => a.id === attrId)!;
    const skill = input.skill ? slugify(input.skill, 24) : null;
    const skillValue = skill ? (c.skills[skill] ?? 0) : 0;
    const target = typeof input.difficulty === 'number' ? input.difficulty : this.state.ruleset.difficulties[input.difficulty];
    if (target === undefined) throw new EngineError(`Dificuldade inválida: ${String(input.difficulty)}.`);
    const dice = parseDice(this.state.ruleset.dice)!;
    const rolls = rollDice(this.state, dice.count, dice.sides);
    const modifier = Math.round(input.modifier ?? 0);
    // Perks e condições com check_bonus que valem para este atributo/perícia (sem filtro = vale para todo teste).
    const perks = [...this.perksOf(c), ...this.conditionsOf(c)].filter((p) =>
      p.grants.some((g) => g.kind === 'check_bonus' && (!g.attribute || g.attribute === attrId) && (!g.skill || g.skill === skill)),
    );
    const perkBonus = perks
      .flatMap((p) => p.grants)
      .reduce((sum, g) => (g.kind === 'check_bonus' && (!g.attribute || g.attribute === attrId) && (!g.skill || g.skill === skill) ? sum + g.bonus : sum), 0);
    // Agir contra quem não se enxerga bem custa caro, salvo ações que não dependem de ver.
    const vision = this.state.ruleset.vision;
    const sightPenalty =
      !opponent || input.needs_sight === false ? 0 : opponent.sight === 'vulto' ? vision.dimPenalty : opponent.sight === 'nada' ? vision.blindPenalty : 0;
    // Pedir, convencer, acalmar ou enganar depende do que o alvo sente por quem tenta.
    const feelingBonus = opponent && input.goodwill ? (this.state.characters[opponent.id].feelings[c.id]?.degree ?? 0) : 0;
    const total =
      rolls.reduce((a, b) => a + b, 0) + dice.bonus + (c.attributes[attrId] ?? 0) + skillValue + modifier + perkBonus - sightPenalty + feelingBonus;
    const margin = total - target;
    const success = margin >= 0;
    const degree = margin >= 4 ? 'sucesso pleno' : success ? 'sucesso' : margin <= -4 ? 'falha grave' : 'falha';
    return {
      character_id: c.id,
      character: c.name,
      against: opponent,
      attribute: { id: attrId, name: attr.name, value: c.attributes[attrId] ?? 0 },
      skill: skill ? { id: skill, value: skillValue } : null,
      modifier,
      perk_bonus: perkBonus,
      perks: perks.map((p) => p.name),
      sight_penalty: sightPenalty,
      feeling_bonus: feelingBonus,
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

  advanceTime(input: { minutes?: number; to?: string; reason?: string }) {
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
    return { from: formatClock(before), to: formatClock(this.state.clock), expired: this.expireConditions() };
  }

  /** Tira as condições cujo prazo passou e diz de quem. */
  private expireConditions(): { character_id: string; character: string; condition: string }[] {
    const now = clockMinutes(this.state.clock);
    const out: { character_id: string; character: string; condition: string }[] = [];
    for (const c of Object.values(this.state.characters)) {
      const ended = c.conditions.filter((a) => a.until && clockMinutes(a.until) <= now);
      if (!ended.length) continue;
      c.conditions = c.conditions.filter((a) => !ended.includes(a));
      for (const a of ended) {
        out.push({ character_id: c.id, character: c.name, condition: this.state.ruleset.conditions.find((d) => d.id === a.id)?.name ?? a.id });
      }
    }
    return out;
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
      perks: this.perksOf(c).map((p) => ({ id: p.id, name: p.name, description: p.description })),
      conditions: this.conditionLabels(c),
      thoughts: c.thoughts,
      feelings: Object.entries(c.feelings).map(([id, f]) => ({ toward: id, name: this.state.characters[id]?.name ?? id, degree: f.degree, text: f.text })),
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
          light: l.light,
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
