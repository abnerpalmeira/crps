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
 * itens do nada (um mágico, um bolso sem fundo), com custo opcional num recurso. `move` mexe nos
 * passos por turno: bonus soma passos (ágil), factor multiplica (perna ferida 0.5, amarrado 0).
 */
export type PerkGrant =
  | { kind: 'see_stat'; stat: string }
  | { kind: 'see_thoughts' }
  | { kind: 'check_bonus'; bonus: number; attribute?: string; skill?: string }
  | { kind: 'sense'; channel: string; multiplier?: number; bonus?: number; factor?: number }
  | ({ kind: 'light' } & LightSpec)
  | { kind: 'conjure'; note?: string; cost?: { resource: string; amount: number } }
  | { kind: 'move'; bonus?: number; factor?: number };

/** Quanto se anda pelo grid entre um turno do mestre e o próximo, sem ele: passos (tiles) por turno. */
export interface MovementRules {
  steps: number;
  /** Atributo que soma passos (ex.: agilidade), cada ponto valendo `perPoint` passos. */
  attribute?: string;
  perPoint?: number;
}

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
  movement: MovementRules;
  /** Teste = dados + atributo + perícia + modificador >= dificuldade. */
  dice: string;
  difficulties: Record<DifficultyName, number>;
  notes: string;
}

/** Corpo no 3D: adultos ou crianças e adolescentes. */
export type Figure = 'adulto' | 'adulta' | 'menino' | 'menina';

/** `sketch` = criado com o mínimo; `full` = aprofundado quando ficou relevante. */
export type DetailLevel = 'sketch' | 'full';

/**
 * Época de uma campanha ou de um lugar, que decide o visual no 3D: móveis, objetos e roupas. Em
 * ordem (eras.ts): na falta de modelo da própria época, a vizinha serve melhor que uma distante.
 */
export type Era = 'antiguidade' | 'medieval' | 'colonial' | 'seculo_xix' | 'atual' | 'futuro';

/** O que alguém sente por uma pessoa: a boa vontade com ela, de -3 a +3, e o porquê numa frase. */
export interface Feeling {
  degree: number;
  text: string;
}

export interface Character {
  id: string;
  name: string;
  isPlayer: boolean;
  role: string;
  appearance: string;
  /** Corpo no 3D; sem ele, a interface deduz pelo papel e pela aparência. */
  figure?: Figure;
  /**
   * Visual no 3D, escolhido pelo mestre: um da lista de visuais ou um personagem do catálogo
   * (`pacote:Arquivo`). A aparência descreve esse modelo.
   */
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
  /**
   * Passos do jogador pelo grid neste turno: o máximo, fixado quando o turno começou (pelo ruleset),
   * e quantos ele já andou sem o mestre. Sem isso, o máximo é o do ruleset agora, e nenhum andado.
   */
  steps?: { max: number; used: number };
  /**
   * Pose do corpo (body.ts: ajoelhado, mirando, caído…); sem ela, de pé. Sentar num assento e
   * deitar numa cama vêm do assento, e quem fica com a vida em 0 cai sozinho. Andar desfaz a pose.
   */
  pose?: string | null;
  /** Para quem ou o quê a pose se volta (mirando, apontando): id de personagem ou de móvel. */
  poseTarget?: string | null;
  /** Quem ele conhece (sabe o nome, reconhece o rosto e a voz): as arestas do grafo de conhecidos. */
  knows: string[];
  /** Conhecidos que ele ouviu falar onde está (id de quem falou → local): sabe quem é mesmo sem ver. */
  voices: Record<string, string>;
  /**
   * O que o NPC sente por cada pessoa (id → sentimento). Como os pensamentos, só o mestre vê, ou
   * quem percebe mentes. O personagem do jogador não tem: o que ele sente, quem diz é o jogador.
   */
  feelings: Record<string, Feeling>;
  /**
   * Falas prontas (set_lines): o que o NPC diz quando o jogador puxa conversa no grid, sem o mestre.
   * As do turno falam do que acabou de acontecer e somem no próximo turno do mestre; as gerais são
   * do jeito da pessoa e ficam. `heard` conta as que o jogador já ouviu desde a última troca.
   * `initiative`, do turno: o NPC não espera e vem até o jogador ("vem") ou chama de onde está ("chama").
   */
  lines?: { turn: ReadyLine[]; general: ReadyLine[]; heard: number; initiative?: 'vem' | 'chama' };
}

/** Uma fala pronta e o que ela revela a quem ouve. */
export interface ReadyLine {
  text: string;
  /** Fato registrado que a fala conta: quem ouve passa a saber, como em share_knowledge. */
  fact?: string;
  /** Quem fala diz o próprio nome: quem ouve passa a conhecê-lo, como em introduce. */
  introduces?: boolean;
  /** Cochichada: quem fala chega perto, e só o jogador ouve (o segredo fica entre os dois). */
  whisper?: boolean;
}

/** Como um item é empunhado (body.ts): decide a mão, o encaixe no 3D e as animações de quem o segura. */
export type Grip = 'pistola' | 'arma_longa' | 'arco' | 'uma_mao' | 'duas_maos' | 'escudo' | 'objeto';

export type Hand = 'direita' | 'esquerda';

export type ItemHolder =
  /** Com um personagem; com `hand`, empunhado (na mão), senão guardado com ele. */
  | { kind: 'character'; id: string; hand?: Hand }
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
  /** Modelo do catálogo 3D (`pacote:Arquivo`): como aparece no chão, num móvel e na mão. */
  model?: string;
  /** Como se empunha; sem ela, objeto. */
  grip?: Grip;
  /**
   * O que está escrito (bilhete, carta, livro, placa): fixo depois de escrito. null é um texto
   * que ainda não foi lido por ninguém: a primeira leitura na narração define o que ele diz.
   */
  text?: string | null;
  /** O fato com o conteúdo do texto: quem lê passa a saber dele, como quem ouve uma fala. */
  textFact?: string;
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
  /** Modelo do catálogo 3D (`pacote:Arquivo`) que o mestre escolheu para o visual. */
  model?: string;
  /** Época do visual padrão (o modelo da biblioteca); sem ela, de hoje. Atemporal serve em qualquer uma. */
  era?: Era | 'atemporal';
  /** O que dá para fazer com ele além do que vem das propriedades (sentar, deitar): "tocar", "abrir". */
  actions?: string[];
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
  /** Tamanho típico em tiles ("1×2"), em que o modelo do 3D cabe sem encolher. */
  size?: string;
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

export type FloorStyle = 'wood' | 'tile' | 'stone' | 'carpet' | 'grass' | 'dirt' | 'metal' | 'marble' | 'concrete';

/** Material das paredes de um local fechado, que o 3D desenha com textura. */
export type WallMaterial = 'reboco' | 'pedra' | 'tijolo' | 'madeira' | 'metal' | 'concreto' | 'azulejo' | 'papel';

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
  /** Época do lugar, que decide o visual dos móveis: a da campanha quando ele foi criado, ou outra. */
  era?: Era;
  /** Paredes: o material e a cor (#rrggbb), se o mestre deu; sem elas, o reboco claro de antes. */
  walls?: { material: WallMaterial; color?: string };
  /** O que enfeita as paredes (quadros, tapeçarias, luminárias…), que o 3D pendura nos trechos livres. */
  decor?: string[];
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

/** `free`: o que o jogador fez no grid entre os turnos do mestre (um passo, uma fala pronta que ouviu). */
export type LogKind = 'player' | 'narration' | 'tool' | 'system' | 'free';

export interface LogEntry {
  turn: number;
  clock: Clock;
  kind: LogKind;
  text: string;
  /** Versão que o jogador vê, quando difere (falas que ele não ouviu viram só o gesto). */
  playerText?: string;
  /** Na narração: as ações que o mestre sugeriu ao jogador, que viram botões. */
  options?: string[];
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
      pose?: string | null;
      poseTarget?: string | null;
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
  /** Época da campanha (define_ruleset); sem ela, como antes: o visual de hoje, sem filtro. */
  era?: Era;
}
