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

/** Quem vê o valor: public (o jogador vê de todos), self (só o próprio), hidden (só o mestre). */
export type Visibility = 'public' | 'self' | 'hidden';

export interface AttributeDef {
  id: string;
  name: string;
  description: string;
  visibility: Visibility;
  /** Valor de quem não informou, inclusive de quem já existia quando o atributo surgiu. */
  default: number;
}

export interface ResourceDef {
  id: string;
  name: string;
  max: number;
  description: string;
  visibility: Visibility;
  /** Recurso universal do motor (a vida): todo personagem tem. */
  core?: boolean;
}

/**
 * Efeito mecânico de um perk, aplicado pelo motor. `sense` mexe num canal sensorial qualquer
 * (som, labios, mente ou um canal novo criado pelo mestre): multiplier substitui o multiplicador
 * base do canal, bonus soma tiles de alcance.
 */
export type PerkGrant =
  | { kind: 'see_stat'; stat: string }
  | { kind: 'see_thoughts' }
  | { kind: 'check_bonus'; bonus: number; attribute?: string; skill?: string }
  | { kind: 'sense'; channel: string; multiplier?: number; bonus?: number };

/** Um jeito de falar: até onde o alvo pode estar e até onde cada canal leva o conteúdo. */
export interface SpeechMode {
  /** Verbo para a interface: "fala", "cochicha", "grita". */
  label: string;
  /** Distância máxima (tiles) entre quem fala e o alvo. */
  reach: number;
  /** Alcance base (tiles) do conteúdo em cada canal sensorial. */
  channels: Record<string, number>;
}

export interface PerkDef {
  id: string;
  name: string;
  description: string;
  grants: PerkGrant[];
}

export type DifficultyName = 'facil' | 'normal' | 'dificil' | 'muito_dificil';

/** Regras da campanha como dados: o modelo define (e estende), o motor valida e aplica. */
export interface Ruleset {
  name: string;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  perks: PerkDef[];
  /** Modos de fala (fala, cochicho, grito e os que o mestre criar). */
  speech: Record<string, SpeechMode>;
  /** Multiplicador base de cada canal sensorial para todo personagem (som 1; mente e labios 0). */
  senses: Record<string, number>;
  /** Alcance (tiles) de ações com alvo: toque, corpo_a_corpo, arremesso… */
  reaches: Record<string, number>;
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
  /** Ids de perks do ruleset. */
  perks: string[];
  /** O que o personagem pensa ou quer agora; só o mestre vê, ou quem tem see_thoughts. */
  thoughts: string | null;
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
  /** Versão que o jogador vê, quando difere (falas que ele não ouviu viram só o gesto). */
  playerText?: string;
}

/** Retrato da cena no fim de um turno: o que o replay precisa para mostrar o passado. */
export interface SceneFrame {
  turn: number;
  clock: Clock;
  characters: Record<
    string,
    { locationId: string | null; pos: Pos | null; seatId: string | null; facing: Dir; resources?: Record<string, number> }
  >;
  items: Record<string, ItemHolder>;
  /** Só os móveis com texto ou estado. */
  fixtures: Record<string, { text: string; state: string }>;
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
  frames: SceneFrame[];
  counters: Record<string, number>;
}
