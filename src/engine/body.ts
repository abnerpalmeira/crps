import { typeChain } from './objects';
import { lifeStatId } from './perception';
import { chebyshev, fold } from './text';
import type { Character, Grip, Hand, Item, WorldState } from './types';

export type { Grip, Hand };

/**
 * O corpo dos personagens, como dados: poses (o estado do corpo, que fica até mudar), gestos (o
 * que o corpo faz num instante e depois volta à pose) e empunhaduras (como um item vai na mão).
 * Cada um diz o clipe de animação do 3D, que pode depender do que a pessoa empunha: "mirando" com
 * uma pistola estica o braço, com um fuzil leva a arma ao rosto, com um arco puxa a corda.
 */

export interface GripDef {
  label: string;
  /** Mão fixa: o arco e o escudo vão na esquerda. Sem ela, vale a pedida (padrão: direita). */
  hand?: Hand;
  /** Ocupa as duas mãos. */
  both?: boolean;
  /** Ataca de longe. */
  ranged?: boolean;
}

export const GRIPS: Record<Grip, GripDef> = {
  pistola: { label: 'arma de fogo curta (pistola, revólver)', ranged: true },
  arma_longa: { label: 'arma longa (fuzil, espingarda, besta)', both: true, ranged: true },
  arco: { label: 'arco', hand: 'esquerda', ranged: true },
  uma_mao: { label: 'arma ou ferramenta de uma mão (espada, faca, machado, porrete, tocha)' },
  duas_maos: { label: 'arma de duas mãos (lança, montante, cajado, machado grande)', both: true },
  escudo: { label: 'escudo', hand: 'esquerda' },
  objeto: { label: 'objeto qualquer (copo, livro, celular, lanterna)' },
};

export const GRIP_IDS = Object.keys(GRIPS) as Grip[];

/**
 * Clipe de animação: um nome; uma lista de variantes (cada personagem fica sempre com a mesma);
 * ou um por empunhadura, com `padrao` para mãos vazias e para o que não tiver o seu.
 */
export type ClipChoice = string | string[] | ({ padrao: string | string[] } & Partial<Record<Grip, string>>);

export interface PoseDef {
  label: string;
  clip: ClipChoice;
  /** Clipe que leva até a pose (cair morto), na mesma ordem das variantes do clip. */
  enter?: string[];
  /** Corpo no chão: o nome e o balão descem. */
  ground?: boolean;
}

export const POSES: Record<string, PoseDef> = {
  de_pe: { label: 'de pé', clip: { padrao: 'idle', uma_mao: 'espada_parado', duas_maos: 'espada_parado', arco: 'arco_parado', arma_longa: 'fuzil_parado' } },
  sentado: { label: 'sentado', clip: 'sentado_chao' },
  deitado: { label: 'deitado', clip: 'deitado', ground: true },
  caido: { label: 'caído no chão', clip: ['caido_costas', 'caido_brucos'], enter: ['morte_costas', 'morte_brucos'], ground: true },
  ajoelhado: { label: 'ajoelhado, de mãos juntas', clip: 'ajoelhado' },
  agachado: { label: 'agachado, escondido', clip: 'agachado' },
  bracos_cruzados: { label: 'de braços cruzados', clip: 'bracos_cruzados' },
  maos_na_cintura: { label: 'com as mãos na cintura', clip: 'maos_na_cintura' },
  maos_ao_alto: { label: 'de mãos ao alto, rendido', clip: 'maos_ao_alto' },
  encostado: { label: 'encostado na parede', clip: 'encostado' },
  pensativo: { label: 'pensativo, mão no queixo', clip: 'pensativo' },
  rezando: { label: 'rezando de pé', clip: 'rezando' },
  ao_telefone: { label: 'falando ao telefone', clip: 'ao_telefone' },
  no_celular: { label: 'mexendo no celular', clip: 'no_celular' },
  segurando_copo: { label: 'segurando um copo', clip: 'segurando_copo' },
  bebado: { label: 'bêbado, cambaleando', clip: 'bebado' },
  timido: { label: 'tímido, encolhido', clip: 'timido' },
  abatido: { label: 'abatido, ombros caídos', clip: 'abatido' },
  ameacador: { label: 'em postura ameaçadora', clip: 'ameacador' },
  atordoado: { label: 'atordoado, zonzo', clip: 'atordoado' },
  em_guarda: {
    label: 'em guarda',
    clip: { padrao: 'espada_guarda', arco: 'arco_guarda', pistola: 'pistola_guarda', arma_longa: 'fuzil_guarda', escudo: 'defesa' },
  },
  mirando: {
    label: 'mirando',
    clip: { padrao: 'pistola_mira', arma_longa: 'fuzil_mira', arco: 'arco_mira', uma_mao: 'espada_guarda', duas_maos: 'espada_guarda', escudo: 'defesa' },
  },
  defendendo: { label: 'defendendo-se, em bloqueio', clip: { padrao: 'defesa', arco: 'arco_defesa' } },
};

export const POSE_IDS = Object.keys(POSES);

export interface GestureDef {
  label: string;
  clip: ClipChoice;
  /** Vira para o alvo antes do gesto. */
  face?: boolean;
  /** Clipe pelo lado de onde o alvo está (o golpe recebido vem de lá). */
  sides?: Record<'frente' | 'tras' | 'esquerda' | 'direita', string>;
  /** Ataque: o motor confere o alcance pela arma na mão, e o 3D mostra o tiro. */
  attack?: boolean;
}

/** Ataque conforme a arma: soco de mão vazia, golpe de espada, tiro. */
const ATTACK = { padrao: 'soco', uma_mao: 'espada_ataque', duas_maos: 'espada_golpe_forte', escudo: 'soco', pistola: 'pistola_tiro', arma_longa: 'fuzil_tiro', arco: 'arco_tiro' } as const;

export const GESTURES: Record<string, GestureDef> = {
  acena: { label: 'acena', clip: 'acena', face: true },
  acena_de_longe: { label: 'acena de longe, braço alto', clip: 'acena_de_longe', face: true },
  chama: { label: 'chama com o dedo', clip: 'chama', face: true },
  aponta: { label: 'aponta para o alvo', clip: 'aponta', face: true },
  sim: { label: 'faz que sim com a cabeça', clip: 'nod' },
  concorda: { label: 'concorda com vontade', clip: 'concorda' },
  agradece: { label: 'agradece com a cabeça', clip: 'agradece', face: true },
  cumprimenta: { label: 'cumprimenta com a cabeça', clip: 'cumprimenta', face: true },
  nao: { label: 'faz que não com a cabeça', clip: 'nao' },
  decepcionado: { label: 'balança a cabeça, decepcionado', clip: 'decepcionado' },
  reverencia: { label: 'faz uma reverência', clip: 'reverencia', face: true },
  mesura: { label: 'faz uma mesura (curvatura com saia)', clip: 'mesura', face: true },
  continencia: { label: 'bate continência', clip: 'continencia', face: true },
  reverencia_marcial: { label: 'reverência de artes marciais', clip: 'reverencia_marcial', face: true },
  aplaude: { label: 'aplaude', clip: 'aplaude' },
  palmas_lentas: { label: 'bate palmas lentas, irônico', clip: 'palmas_lentas', face: true },
  comemora: { label: 'comemora com o punho', clip: 'comemora' },
  vibra: { label: 'vibra de braços erguidos', clip: 'vibra' },
  joinha: { label: 'faz joinha', clip: 'joinha', face: true },
  polegar_para_baixo: { label: 'polegar para baixo', clip: 'polegar_para_baixo', face: true },
  mao_no_peito: { label: 'põe a mão no peito', clip: 'mao_no_peito' },
  beijo: { label: 'manda um beijo', clip: 'beijo', face: true },
  coracao: { label: 'faz coração com as mãos', clip: 'coracao', face: true },
  encolhe_ombros: { label: 'encolhe os ombros', clip: 'encolhe_ombros' },
  facepalm: { label: 'leva a mão à testa', clip: 'facepalm' },
  chora: { label: 'chora', clip: 'chora' },
  cansado: { label: 'suspira, cansado', clip: 'cansado' },
  danca: { label: 'dança', clip: 'danca' },
  ri_e_aponta: { label: 'ri e aponta, zombando', clip: 'ri_e_aponta', face: true },
  shhh: { label: 'pede silêncio (shhh)', clip: 'shhh', face: true },
  lingua: { label: 'mostra a língua', clip: 'lingua', face: true },
  calma: { label: 'pede calma com as mãos', clip: 'calma', face: true },
  nao_nao: { label: 'balança o dedo: não, não', clip: 'nao_nao', face: true },
  dispensa: { label: 'dispensa com a mão', clip: 'dispensa', face: true },
  maluco: { label: 'bate na têmpora: tá maluco?', clip: 'maluco', face: true },
  punho: { label: 'sacode o punho, bravo', clip: 'punho', face: true },
  birra: { label: 'faz birra', clip: 'birra' },
  ruge: { label: 'ruge, ameaçador', clip: 'ruge', face: true },
  ameaca: { label: 'passa o dedo no pescoço, ameaçando', clip: 'ameaca', face: true },
  punhos: { label: 'ergue os punhos, provocando', clip: 'punhos', face: true },
  flexiona: { label: 'flexiona os bíceps', clip: 'flexiona' },
  bate_no_peito: { label: 'bate no peito', clip: 'bate_no_peito' },
  boceja: { label: 'boceja', clip: 'boceja' },
  espreguica: { label: 'se espreguiça', clip: 'espreguica' },
  olha_relogio: { label: 'olha o relógio', clip: 'olha_relogio' },
  coca_queixo: { label: 'coça o queixo, pensando', clip: 'coca_queixo' },
  olha_para_tras: { label: 'olha para trás', clip: 'olha_para_tras' },
  assustado: { label: 'olha em volta, assustado', clip: 'assustado' },
  implora: { label: 'implora', clip: 'implora', face: true },
  impaciente: { label: 'bate o pé, impaciente', clip: 'impaciente' },
  bebe: { label: 'bebe um gole', clip: 'bebe' },
  vira_o_copo: { label: 'vira a bebida de uma vez', clip: 'gole' },
  come: { label: 'come', clip: 'come' },
  foto: { label: 'tira uma foto com o celular', clip: 'foto', face: true },
  examina: { label: 'examina as próprias mãos', clip: 'examina' },
  ataca: { label: 'ataca o alvo com o que empunha (soco, golpe, tiro, flecha)', clip: ATTACK, face: true, attack: true },
  golpe_forte: { label: 'golpe forte', clip: { ...ATTACK, uma_mao: 'espada_golpe_forte' }, face: true, attack: true },
  estocada: { label: 'estocada', clip: { ...ATTACK, uma_mao: 'estocada', duas_maos: 'estocada' }, face: true, attack: true },
  defende: { label: 'apara ou bloqueia um golpe', clip: 'defende', face: true },
  esquiva: { label: 'esquiva', clip: ['esquiva_esquerda', 'esquiva_direita', 'esquiva_tras'], face: true },
  rola: { label: 'rola no chão para escapar', clip: 'rola' },
  atingido: {
    label: 'é atingido (o alvo é quem bateu)',
    clip: 'atingido_frente',
    sides: { frente: 'atingido_frente', tras: 'atingido_tras', esquerda: 'atingido_esquerda', direita: 'atingido_direita' },
  },
  cambaleia: { label: 'cambaleia com o impacto', clip: 'cambaleia' },
  saca: { label: 'saca a arma', clip: 'saca_espada' },
  guarda_arma: { label: 'guarda a arma', clip: 'guarda_espada' },
};

export const GESTURE_IDS = Object.keys(GESTURES);

/** Outros verbos que o mestre usa para os mesmos gestos. */
const SYNONYMS: Record<string, string> = {
  atira: 'ataca',
  dispara: 'ataca',
  golpeia: 'ataca',
  soca: 'ataca',
  bate: 'ataca',
  flecha: 'ataca',
  apara: 'defende',
  bloqueia: 'defende',
  desvia: 'esquiva',
  balanca_a_cabeca: 'nao',
  assente: 'sim',
};

/**
 * O gesto que o mestre quis dizer: o id da tabela, um sinônimo (atira, dispara → ataca) ou o
 * infinitivo de um deles (acenar → acena, aplaudir → aplaude, cambalear → cambaleia); null se
 * nenhum serve.
 */
export function resolveGesture(id: string): string | null {
  const known = (g: string) => (GESTURES[g] ? g : SYNONYMS[g] ?? null);
  const verb = id.replace(/ear$/, 'eia').replace(/ir$/, 'e').replace(/([ae])r$/, '$1');
  return known(id) ?? known(verb);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** O clipe de uma escolha, pela empunhadura; variantes saem pela chave (sempre a mesma por personagem). */
export function clipFor(choice: ClipChoice, grip: Grip | null, key: string): string {
  const pick = (v: string | string[]) => (Array.isArray(v) ? v[hash(key) % v.length] : v);
  if (typeof choice === 'string' || Array.isArray(choice)) return pick(choice);
  return pick((grip && choice[grip]) || choice.padrao);
}

/** Índice da variante que a chave escolhe numa lista (para o clipe de entrada casar com a pose). */
export function variantIndex(length: number, key: string): number {
  return hash(key) % Math.max(1, length);
}

export function gripOf(item: Item): Grip {
  return item.grip ?? 'objeto';
}

/** O que a pessoa tem em cada mão; uma arma de duas mãos aparece nas duas. */
export function handsOf(world: Pick<WorldState, 'items'>, characterId: string): Record<Hand, Item | null> {
  const hands: Record<Hand, Item | null> = { direita: null, esquerda: null };
  for (const item of Object.values(world.items)) {
    const h = item.holder;
    if (h.kind !== 'character' || h.id !== characterId || !h.hand) continue;
    if (GRIPS[gripOf(item)].both) hands.direita = hands.esquerda = item;
    else hands[h.hand] = item;
  }
  return hands;
}

/**
 * A empunhadura que manda nas animações: a da arma de duas mãos, depois a do arco, depois a do
 * que está na direita e por fim a do que está na esquerda. Mãos vazias: null.
 */
export function mainGrip(world: Pick<WorldState, 'items'>, characterId: string): { grip: Grip; item: Item } | null {
  const { direita, esquerda } = handsOf(world, characterId);
  const order = [direita, esquerda].filter((i): i is Item => Boolean(i));
  const item = order.find((i) => GRIPS[gripOf(i)].both) ?? order.find((i) => gripOf(i) === 'arco') ?? order[0];
  return item ? { grip: gripOf(item), item } : null;
}

/** A mão em que um item vai: a fixa da empunhadura ou a pedida (padrão, a direita). */
export function handFor(item: Item, asked: Hand | undefined): Hand {
  const def = GRIPS[gripOf(item)];
  return def.hand ?? (def.both ? 'direita' : (asked ?? 'direita'));
}

/**
 * A pose que o corpo mostra agora: num assento, sentado (deitado, se for cama); com a vida em 0,
 * caído (salvo se já está deitado); senão a que o mestre deu, ou de pé.
 */
export function bodyPose(world: WorldState, c: Character): string {
  if (c.seatId) {
    const seat = c.locationId ? world.locations[c.locationId]?.fixtures.find((f) => f.id === c.seatId) : undefined;
    return seat && typeChain(world, seat.kind).some((t) => t.bed) ? 'deitado' : 'sentado';
  }
  const life = lifeStatId(world);
  if (life && (c.resources[life] ?? 1) <= 0 && !POSES[c.pose ?? '']?.ground) return 'caido';
  return c.pose && POSES[c.pose] ? c.pose : 'de_pe';
}

/** Um gesto marcado na narração: `{id:gesto}` ou `{id:gesto>alvo}`. */
export interface Act {
  actorId: string;
  gesture: string;
  targetId: string | null;
}

const ACT_TAG = /\{\s*([a-z0-9_]+)\s*:\s*([a-z0-9_]+)\s*(?:>\s*([a-z0-9_/-]+)\s*)?\}/gi;

/** As marcas de gesto do texto, com o gesto já no id da tabela quando ele tem sinônimo ou veio no infinitivo. */
export function parseActs(text: string): Act[] {
  return [...text.matchAll(ACT_TAG)].map((m) => {
    const gesture = fold(m[2]);
    return { actorId: m[1].toLowerCase(), gesture: resolveGesture(gesture) ?? gesture, targetId: m[3]?.toLowerCase() ?? null };
  });
}

/** O texto sem as marcas de gesto, como o jogador lê. */
export function stripActs(text: string): string {
  return text.replace(ACT_TAG, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?…;:])/g, '$1').trim();
}

/** A linha só com as marcas de gesto de quem passa no filtro. */
export function filterActs(text: string, keep: (act: Act) => boolean): string {
  return text
    .replace(ACT_TAG, (tag, actor: string, gesture: string, target?: string) =>
      keep({ actorId: actor.toLowerCase(), gesture: gesture.toLowerCase(), targetId: target?.toLowerCase() ?? null }) ? tag : '',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trimEnd();
}

/** As marcas de gesto de um texto, como texto (para levar de uma linha para outra). */
export function actTags(text: string): string[] {
  return text.match(ACT_TAG) ?? [];
}

/**
 * Confere os gestos da narração contra o mundo: quem faz existe e está em cena, o gesto existe, o
 * alvo está no mesmo local, e um ataque de perto alcança o alvo (de longe, só com a arma na mão).
 */
export function analyzeActs(world: WorldState, narration: string): string[] {
  const issues: string[] = [];
  const life = lifeStatId(world);
  for (const act of parseActs(narration)) {
    const tag = `{${act.actorId}:${act.gesture}${act.targetId ? `>${act.targetId}` : ''}}`;
    const actor = world.characters[act.actorId];
    if (!actor) {
      issues.push(`A marca ${tag} usa "${act.actorId}", que não é id de personagem.`);
      continue;
    }
    const gesture = GESTURES[act.gesture];
    if (!gesture) {
      const close = GESTURE_IDS.filter((g) => g.startsWith(act.gesture.slice(0, 3))).slice(0, 6);
      issues.push(`O gesto "${act.gesture}" (${tag}) não existe${close.length ? `; parecidos: ${close.join(', ')}` : ''}. Use um da lista de gestos.`);
      continue;
    }
    if (!actor.locationId || !actor.pos) {
      issues.push(`${actor.name} não está em cena para fazer ${tag}.`);
      continue;
    }
    if (life && (actor.resources[life] ?? 1) <= 0) {
      issues.push(`${actor.name} está fora de ação (vida 0) e não faz ${tag}.`);
      continue;
    }
    if (!act.targetId) continue;
    const target = world.characters[act.targetId];
    const fixture = target ? null : world.locations[actor.locationId].fixtures.find((f) => f.id === act.targetId || f.id.endsWith(`/${act.targetId}`));
    if (!target && !fixture) {
      issues.push(`O alvo de ${tag} não é personagem nem objeto de ${actor.locationId}.`);
      continue;
    }
    if (target && (target.locationId !== actor.locationId || !target.pos)) {
      issues.push(`${actor.name} e ${target.name} não estão no mesmo local (${tag}).`);
      continue;
    }
    if (!gesture.attack) continue;
    const grip = mainGrip(world, actor.id)?.grip ?? null;
    if (grip && GRIPS[grip].ranged) continue;
    const reach = (world.ruleset.reaches.corpo_a_corpo ?? 1) + (grip === 'duas_maos' ? 1 : 0);
    const d = target ? chebyshev(actor.pos, target.pos!) : Math.max(0, Math.max(fixture!.x - actor.pos.x, actor.pos.x - (fixture!.x + fixture!.w - 1), fixture!.y - actor.pos.y, actor.pos.y - (fixture!.y + fixture!.h - 1)));
    if (d > reach) {
      issues.push(
        `${actor.name} ataca ${target?.name ?? fixture!.label} a ${d} tiles sem arma de alcance na mão (de perto alcança ${reach}). ` +
          `Aproxime com move_character, ou ponha a arma na mão com transfer_item (to.hand) antes.`,
      );
    }
  }
  return issues;
}
