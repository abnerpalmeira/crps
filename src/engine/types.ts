export type Dir = 'N' | 'E' | 'S' | 'W';

export interface Pos {
  x: number;
  y: number;
}

/** Relógio do jogo: dia (1, 2, ...) e minutos desde 00:00. */
export interface Clock {
  day: number;
  minutes: number;
}

export interface AttributeDef {
  id: string;
  name: string;
  description: string;
}

export interface ResourceDef {
  id: string;
  name: string;
  max: number;
  description: string;
}

export type DifficultyName = 'facil' | 'normal' | 'dificil' | 'muito_dificil';

/** Regras da campanha como dados: o modelo define, o motor valida e aplica. */
export interface Ruleset {
  name: string;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  /** Teste = dados + atributo + perícia + modificador >= dificuldade. */
  dice: string;
  difficulties: Record<DifficultyName, number>;
  notes: string;
}

/** `sketch` = criado com o mínimo; `full` = aprofundado quando ficou relevante. */
export type DetailLevel = 'sketch' | 'full';

export interface Character {
  id: string;
  name: string;
  isPlayer: boolean;
  role: string;
  appearance: string;
  traits: string[];
  attributes: Record<string, number>;
  skills: Record<string, number>;
  resources: Record<string, number>;
  detail: DetailLevel;
  personality: string | null;
  background: string | null;
  goals: string | null;
  locationId: string | null;
  pos: Pos | null;
  facing: Dir;
  seatId: string | null;
}

export type ItemHolder =
  | { kind: 'character'; id: string }
  | { kind: 'fixture'; id: string }
  | { kind: 'ground'; locationId: string; x: number; y: number };

export interface Item {
  id: string;
  name: string;
  description: string;
  tags: string[];
  quantity: number;
  holder: ItemHolder;
}

export type FixtureKind =
  | 'door'
  | 'window'
  | 'board'
  | 'teacher_desk'
  | 'desk'
  | 'chair'
  | 'table'
  | 'shelf'
  | 'locker'
  | 'plant'
  | 'bed'
  | 'sofa'
  | 'counter'
  | 'crate';

/** Móvel ou elemento fixo gerado a partir do layout ASCII. */
export interface Fixture {
  id: string;
  kind: FixtureKind;
  label: string;
  locationId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  facing: Dir;
  seat: boolean;
  wall: boolean;
  text: string;
  state: string;
}

export type FloorStyle = 'wood' | 'tile' | 'stone' | 'carpet' | 'grass' | 'dirt';

export interface Location {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  tiles: string[];
  fixtures: Fixture[];
  floor: FloorStyle;
  outdoor: boolean;
}

export interface Fact {
  id: string;
  subject: string;
  text: string;
  /** Quem conhece o fato dentro da ficção (o mestre sempre conhece). */
  knownBy: string[] | 'all';
  turn: number;
  clock: Clock;
}

export type ThreadStatus = 'open' | 'resolved' | 'failed';

export interface Thread {
  id: string;
  title: string;
  description: string;
  status: ThreadStatus;
  updatedTurn: number;
}

export type LogKind = 'player' | 'narration' | 'tool' | 'system';

export interface LogEntry {
  turn: number;
  clock: Clock;
  kind: LogKind;
  text: string;
}

export interface WorldState {
  version: 1;
  id: string;
  premise: string;
  createdAt: string;
  seed: number;
  rng: number;
  turn: number;
  clock: Clock;
  ruleset: Ruleset;
  playerId: string | null;
  locations: Record<string, Location>;
  characters: Record<string, Character>;
  items: Record<string, Item>;
  facts: Fact[];
  threads: Record<string, Thread>;
  log: LogEntry[];
  counters: Record<string, number>;
}
