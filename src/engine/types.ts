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

/** Luz emitida por um item aceso ou por um poder: alcance em tiles e força de 0 a 1. */
export interface LightSpec {
  radius: number;
  intensity: number;
  /** Cor para o 3D, ex. "#ffd9a0" (padrão: amarelada). */
  color?: string;
}

/**
 * Efeito mecânico de um perk ou de uma condição, aplicado pelo motor. `sense` mexe num canal
 * sensorial qualquer (som, labios, mente, visao ou um canal novo criado pelo mestre): multiplier
 * substitui o multiplicador base do canal, bonus soma tiles de alcance e factor multiplica o
 * resultado (0 = perdeu o sentido). `light` faz o dono emitir luz. `conjure` deixa o dono tirar
 * itens do nada (um mágico, um bolso sem fundo), com custo opcional num recurso.
 */
export type PerkGrant =
  | { kind: 'see_stat'; stat: string }
  | { kind: 'see_thoughts' }
  | { kind: 'check_bonus'; bonus: number; attribute?: string; skill?: string }
  | { kind: 'sense'; channel: string; multiplier?: number; bonus?: number; factor?: number }
  | ({ kind: 'light' } & LightSpec)
  | { kind: 'conjure'; note?: string; cost?: { resource: string; amount: number } };

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

/** Quanto se enxerga: clareza = luz no alvo × acuidade, caindo com a distância. */
export interface VisionRules {
  /** Clareza mínima para ver nítido. */
  clear: number;
  /** Clareza mínima para ver um vulto. */
  dim: number;
  /** Penalidade em testes com alvo que o personagem só vê como vulto. */
  dimPenalty: number;
  /** Penalidade em testes com alvo que o personagem não vê. */
  blindPenalty: number;
}

/** Regras da campanha como dados: o modelo define (e estende), o motor valida e aplica. */
export interface Ruleset {
  name: string;
  attributes: AttributeDef[];
  resources: ResourceDef[];
  perks: PerkDef[];
  /** Condições (cego, visão turva, ofuscado…): têm os mesmos efeitos de um perk, mas vêm e vão. */
  conditions: PerkDef[];
  /** Modos de fala (fala, cochicho, grito e os que o mestre criar). */
  speech: Record<string, SpeechMode>;
  /** Multiplicador base de cada canal sensorial para todo personagem (som e visao 1; mente e labios 0). */
  senses: Record<string, number>;
  /** Canais que só funcionam vendo quem emite (ler lábios, língua de sinais). */
  sightChannels: string[];
  vision: VisionRules;
  /** Alcance (tiles) de ações com alvo: toque, corpo_a_corpo, arremesso… */
  reaches: Record<string, number>;
  /** Teste = dados + atributo + perícia + modificador >= dificuldade. */
  dice: string;
  difficulties: Record<DifficultyName, number>;
  notes: string;
}

/** Corpo no 3D: adultos ou crianças e adolescentes. */
export type Figure = 'adulto' | 'adulta' | 'menino' | 'menina';

/** `sketch` = criado com o mínimo; `full` = aprofundado quando ficou relevante. */
export type DetailLevel = 'sketch' | 'full';

export interface Character {
  id: string;
  name: string;
  isPlayer: boolean;
  role: string;
  appearance: string;
  /** Corpo no 3D; sem ele, a interface deduz pelo papel e pela aparência. */
  figure?: Figure;
  /** Visual no catálogo 3D, escolhido pelo mestre; a aparência descreve esse modelo. */
  look?: string;
  /** Como quem não o conhece o chama, pelo que vê ("o homem de terno"). */
  seenAs?: string;
  traits: string[];
  attributes: Record<string, number>;
  skills: Record<string, number>;
  resources: Record<string, number>;
  /** Ids de perks do ruleset. */
  perks: string[];
  /** Condições ativas: id em ruleset.conditions e quando acabam (null = até alguém tirar). */
  conditions: { id: string; until: Clock | null }[];
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
  /** Quem ele conhece (sabe o nome, reconhece o rosto e a voz): as arestas do grafo de conhecidos. */
  knows: string[];
  /** Conhecidos que ele ouviu falar onde está (id de quem falou → local): sabe quem é mesmo sem ver. */
  voices: Record<string, string>;
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
  /** Itens que iluminam (lanterna, vela, tocha), acesos ou não. */
  light?: LightSpec & { on: boolean };
}

/** Id de um tipo de objeto: da biblioteca (door, desk, vitrine…) ou criado pelo mestre. */
export type FixtureKind = string;

/** Como um objeto se orienta ao ser posto no layout. */
export type FacingRule = 'interior' | 'board' | 'away_board' | 'table' | 'open_side' | 'lengthwise' | 'none';

/**
 * Tipo de objeto do mundo, como dado: o que ele é fisicamente e como aparece quando não há
 * modelo. Os de sempre têm um caractere fixo na legenda; os outros entram num local pela
 * legenda dele (`"V": "vitrine"`), e o mestre cria tipos novos a partir de um parecido (like).
 */
export interface ObjectType {
  id: string;
  /** Nome em português, como aparece no resumo e na interface. */
  label: string;
  /** Prefixo dos ids no local (`sala/carteira-3`); sem ele, vem do nome. */
  slug?: string;
  /** Caractere fixo na legenda (só os de sempre). */
  char?: string;
  passable?: boolean;
  /** Fica na linha da parede (porta, janela, quadro). */
  wall?: boolean;
  seat?: boolean;
  /** Cama: dá para deitar, e ninguém é sentado nela ao acaso. */
  bed?: boolean;
  /** Caracteres iguais vizinhos viram um só objeto de vários tiles. */
  merge?: boolean;
  facing?: FacingRule;
  /** Mesa: as cadeiras em volta se viram para ela. */
  table?: boolean;
  /** Leva a outro local: a um só (porta) ou a qualquer andar (elevador, escada). */
  exit?: 'door' | 'floors';
  /** Altura em que itens ficam apoiados (m). */
  surface?: number;
  /** Altura da primitiva (m), quando não há modelo. */
  height?: number;
  /** Tamanho típico em tiles (largura×profundidade), em que o modelo do 3D cabe sem encolher. */
  size?: string;
  color?: string;
  article?: 'o' | 'a';
  /** Tipo da biblioteca de onde vieram o resto das propriedades e o visual. */
  like?: string;
}

/** Um caractere da legenda do layout e o que ele é. */
export interface TileDef {
  char: string;
  /** 'wall', 'floor', 'void' ou o id do tipo de objeto. */
  kind: string;
  label: string;
  /** Prefixo dos ids de móveis (`sala/carteira-3`). */
  slug: string;
  passable: boolean;
  /** Faz parte da linha da parede (porta, janela, quadro). */
  wall: boolean;
  seat: boolean;
  /** Caracteres iguais vizinhos viram um único móvel de vários tiles. */
  merge: boolean;
  facing: FacingRule;
  /** Mesa: as cadeiras em volta se viram para ela. */
  table?: boolean;
  /** Leva a outro local: a um só (porta) ou a qualquer andar (elevador, escada). */
  exit?: 'door' | 'floors';
}

/** Móvel ou elemento fixo gerado a partir do layout ASCII. */
export interface Fixture {
  id: string;
  /** Id do tipo de objeto (biblioteca ou criado pelo mestre). */
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
  /** Saída do local: a um lugar só (porta) ou a qualquer andar (elevador, escada). */
  exit?: 'door' | 'floors';
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
  /** Luz ambiente, de 0 (breu) a 1 (dia claro ou luzes acesas). */
  light: number;
  /** Portas, elevadores e escadas, pelo id do móvel: para onde levam. */
  exits: Record<string, Exit>;
  /** Caracteres extras do layout deste local (além da legenda fixa), cada um com seu tipo. */
  legend?: Record<string, TileDef>;
}

/**
 * Saída de um local e para onde leva. Porta leva a um lugar só; elevador e escada levam a todos os
 * andares por onde alguém já passou. Vazio enquanto ninguém passou por ela.
 */
export interface Exit {
  to: string[];
  label: string;
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
    {
      locationId: string | null;
      pos: Pos | null;
      seatId: string | null;
      facing: Dir;
      resources?: Record<string, number>;
      conditions?: Character['conditions'];
    }
  >;
  items: Record<string, ItemHolder>;
  /** Só os móveis com texto ou estado. */
  fixtures: Record<string, { text: string; state: string }>;
  /** Luz ambiente de cada local e quais itens estavam acesos. */
  light?: { locations: Record<string, number>; items: Record<string, boolean> };
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
  /** Tipos de objeto criados pelo mestre nesta campanha (os da biblioteca ficam no código). */
  objectTypes: Record<string, ObjectType>;
}
