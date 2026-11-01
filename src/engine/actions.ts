import { GESTURES, GESTURE_IDS, GRIPS, POSES, POSE_IDS, bodyPose, gripOf, handsOf } from './body';
import type { FreeAct } from './free';
import { hasNews, nextLine } from './lines';
import { objectType, typeChain } from './objects';
import { perceptionOf, strangerLabel } from './perception';
import { itemPlace } from './reading';
import { distanceToRect, slugify } from './text';
import type { Character, Fixture, Item, Location, WorldState } from './types';

/**
 * Ações do jogador pelo menu do 3D, como dados. O que dá para fazer com cada coisa sai das
 * propriedades dela (assento, cama, saída, superfície, luz, texto, arma na mão) e dos verbos do
 * tipo de objeto (`actions`, que o mestre também dá aos tipos que cria). Cada ação vira uma marca
 * na ação do jogador, `{verbo>alvo}` ou `{verbo>alvo>outro}`, com os ids: as físicas o motor faz
 * na hora (perform.ts), e as outras vão ao mestre com os ids e a tool que resolve.
 */

/** Uma ação escolhida no menu. */
export interface MenuAct {
  verb: string;
  target: string | null;
  other: string | null;
}

/** Uma opção do menu: uma marca para a ação, um texto para completar ou mais uma escolha. */
export interface ActionOption {
  label: string;
  /** Marca que entra na ação do jogador. */
  token?: string;
  /** Texto que preenche a caixa (fala, escrita): o jogador completa. */
  prefill?: string;
  /** Ação livre: o motor faz na hora, sem o mestre (andar, conversar com as falas prontas). */
  free?: FreeAct;
  /** Escolha seguinte: a quem entregar, que item pôr, que gesto. */
  options?: ActionOption[];
  /** Observação: distância, quem ocupa. */
  note?: string;
  disabled?: boolean;
}

interface VerbDef {
  icon: string;
  /** O motor faz na hora (ação física certa); sem isso, vai ao mestre. */
  motor: boolean;
  /** Ação livre pelo menu: acontece já, sem esperar o turno do mestre (free.ts). */
  free?: boolean;
  /** Frase com {alvo} e {outro}. */
  text: string;
  /** Para o mestre: como resolver ({eu}, {alvo_id} e {outro_id} viram ids). */
  hint?: string;
}

export const VERBS: Record<string, VerbDef> = {
  ir: { icon: '🚶', motor: true, text: 'ir até {alvo}' },
  sentar: { icon: '🪑', motor: true, free: true, text: 'sentar em {alvo}' },
  deitar: { icon: '🛏️', motor: true, free: true, text: 'deitar em {alvo}' },
  levantar: { icon: '🧍', motor: true, free: true, text: 'levantar' },
  pose: { icon: '🧘', motor: true, free: true, text: 'ficar {alvo}' },
  mirar: { icon: '🎯', motor: true, text: 'mirar em {alvo}' },
  pegar: { icon: '✋', motor: true, free: true, text: 'pegar {alvo}' },
  empunhar: { icon: '🗡️', motor: true, free: true, text: 'empunhar {alvo}' },
  guardar: { icon: '🎒', motor: true, free: true, text: 'guardar {alvo}' },
  largar: { icon: '⬇️', motor: true, free: true, text: 'largar {alvo}' },
  acender: { icon: '💡', motor: true, free: true, text: 'acender {alvo}' },
  apagar: { icon: '🌑', motor: true, free: true, text: 'apagar {alvo}' },
  por: { icon: '📥', motor: true, free: true, text: 'pôr {alvo} em {outro}' },
  passar: { icon: '🚪', motor: true, free: true, text: 'passar por {alvo}' },
  entregar: { icon: '🤝', motor: false, text: 'entregar {alvo} para {outro}', hint: 'transfer_item para a pessoa, que pode aceitar ou recusar' },
  ler: { icon: '📜', motor: false, text: 'ler {alvo}', hint: 'narre a leitura numa linha própria, @{alvo_id}[>{eu}]: texto' },
  gesto: { icon: '👋', motor: false, text: '{alvo}', hint: 'marque o gesto na narração' },
  atacar: {
    icon: '⚔️',
    motor: false,
    text: 'atacar {alvo}',
    hint: 'skill_check com target_id e reach, dano com update_character e a marca {{eu}:ataca>{alvo_id}} na narração',
  },
};

const TOKEN = /\{\s*([a-z_]+)\s*(?:>\s*([^\s{}>]+)\s*)?(?:>\s*([^\s{}>]+)\s*)?\}/gi;

/** As ações do menu que estão na ação do jogador. */
export function parseMenuActs(text: string): MenuAct[] {
  return [...text.matchAll(TOKEN)].map((m) => ({ verb: m[1].toLowerCase(), target: m[2]?.toLowerCase() ?? null, other: m[3]?.toLowerCase() ?? null }));
}

export function menuToken(verb: string, target?: string | null, other?: string | null): string {
  return `{${[verb, target, other].filter(Boolean).join('>')}}`;
}

/** A ação com cada marca do menu trocada pelo ícone e a frase dela (para legendas). */
export function labelMenuActs(text: string, world: WorldState | null): string {
  return text.replace(TOKEN, (token) => actLabel(world, parseMenuActs(token)[0]));
}

/** Verbo de um tipo de objeto ("jogar sinuca") como vai na marca: jogar_sinuca. */
export function verbSlug(label: string): string {
  return slugify(label, 24).replace(/-/g, '_');
}

function locationOf(world: WorldState, fixtureId: string): Location | null {
  return Object.values(world.locations).find((l) => l.fixtures.some((f) => f.id === fixtureId || f.id.endsWith(`/${fixtureId}`))) ?? null;
}

/** O móvel pelo id inteiro (`sala/cadeira-3`) ou curto (`cadeira-3`), de preferência no local do jogador. */
export function findFixtureRef(world: WorldState, ref: string): Fixture | null {
  const here = world.playerId ? world.characters[world.playerId]?.locationId : null;
  const all = Object.values(world.locations).flatMap((l) => l.fixtures);
  const matches = all.filter((f) => f.id === ref || f.id.endsWith(`/${ref}`));
  return matches.find((f) => f.locationId === here) ?? matches[0] ?? null;
}

/** Como o jogador chama alguém: o nome de quem ele conhece, a descrição de um estranho. */
function shown(world: WorldState, c: Character): string {
  if (c.isPlayer || !world.playerId) return c.name;
  return perceptionOf(world, world.playerId).recognize(c.id) ? c.name.split(' ')[0] : strangerLabel(c);
}

/** Nome de um alvo de ação: pessoa, móvel, item, pose ou gesto. `ids` acrescenta o id (para o mestre). */
function refName(world: WorldState, ref: string | null, ids: boolean): string {
  if (!ref) return '';
  const tag = (name: string, id: string) => (ids ? `${name} [${id}]` : name);
  const c = world.characters[ref];
  if (c) return tag(ids ? c.name : shown(world, c), c.id);
  const item = world.items[ref];
  if (item) return tag(item.name, item.id);
  const f = findFixtureRef(world, ref);
  if (f) return tag(locationOf(world, f.id)?.exits?.[f.id]?.label ?? f.label, f.id);
  if (POSES[ref]) return POSES[ref].label;
  if (GESTURES[ref]) return GESTURES[ref].label;
  return ref;
}

/** A ação em português: "sentar em cadeira", "entregar caneta para Mei". `ids` traz os ids. */
export function describeAct(world: WorldState, act: MenuAct, ids = false): string {
  const def = VERBS[act.verb];
  const target = refName(world, act.target, ids);
  const other = refName(world, act.other, ids);
  if (!def) return `${act.verb.replace(/_/g, ' ')} ${target}`.trim();
  const text = def.text.replace('{alvo}', target).replace('{outro}', other);
  return act.verb === 'gesto' && other ? `${text} para ${other}` : text;
}

/** O ícone e a frase da ação, para o chip da interface. */
export function actLabel(world: WorldState | null, act: MenuAct): string {
  const icon = VERBS[act.verb]?.icon ?? '✨';
  return `${icon} ${world ? describeAct(world, act) : [act.verb.replace(/_/g, ' '), act.target, act.other].filter(Boolean).join(' ')}`;
}

/** A dica para o mestre resolver uma ação que não é do motor, com os ids. */
export function actHint(world: WorldState, act: MenuAct): string {
  const me = world.playerId ?? 'jogador';
  const def = VERBS[act.verb];
  if (!def) return 'resolva com as tools que couberem (update_fixture para o estado do objeto, skill_check se o resultado for incerto)';
  let hint = (def.hint ?? '').replace('{eu}', me).replace('{alvo_id}', act.target ?? '').replace('{outro_id}', act.other ?? '');
  if (act.verb === 'gesto') hint = `marque {${me}:${act.target}${act.other ? `>${act.other}` : ''}} na narração`;
  return hint;
}

/** Gestos que fazem sentido no menu (os de combate têm ações próprias). */
const MENU_GESTURES = GESTURE_IDS.filter((g) => !GESTURES[g].attack && !['atingido', 'cambaleia', 'esquiva', 'rola', 'defende', 'saca', 'guarda_arma'].includes(g));

/** Poses que o jogador escolhe para o próprio corpo (sentar e deitar num móvel vêm do móvel). */
const MENU_POSES = POSE_IDS.filter((p) => !['de_pe', 'caido', 'mirando'].includes(p));

/**
 * O que o jogador pode fazer com uma pessoa, um móvel, um item ou consigo mesmo, com a distância
 * quando ele precisa ir até lá (o motor leva). Pessoas que ele não enxerga não entram nas listas.
 */
export function actionsFor(world: WorldState, pick: { kind: 'character' | 'fixture' | 'item'; id: string }): ActionOption[] {
  const me = world.playerId ? world.characters[world.playerId] : null;
  if (!me?.pos || !me.locationId) return [];
  const view = perceptionOf(world, me.id);
  const away = (d: number | null) => (d !== null && d > 1 ? `a ${d} passos: você vai até lá` : undefined);
  const distTo = (rect: { x: number; y: number; w: number; h: number }) => distanceToRect(me.pos!, rect);
  const inventory = Object.values(world.items).filter((i) => i.holder.kind === 'character' && i.holder.id === me.id);
  const people = Object.values(world.characters)
    .filter((c) => !c.isPlayer && c.pos && c.locationId === me.locationId && (view.recognize(c.id) || view.sight(c.id) === 'nitido'))
    .sort((a, b) => distTo({ ...a.pos!, w: 1, h: 1 }) - distTo({ ...b.pos!, w: 1, h: 1 }));
  const hands = handsOf(world, me.id);
  const weapon = [hands.direita, hands.esquerda].find((i) => i && GRIPS[gripOf(i)].ranged) ?? null;
  const out: ActionOption[] = [];
  // A ação livre acontece na hora; as outras viram marca na caixa e vão ao mestre com o turno.
  const act = (label: string, verb: string, target?: string | null, other?: string | null, extra: Partial<ActionOption> = {}): ActionOption => ({
    label,
    ...(VERBS[verb]?.free ? { free: { kind: 'act' as const, verb, target: target ?? null, other: other ?? null } } : { token: menuToken(verb, target, other) }),
    ...extra,
  });
  /** Marca para o mestre, mesmo de um verbo livre: sacar uma arma, passar para um lugar que ainda não existe. */
  const toMaster = (verb: string, target?: string | null, other?: string | null): Partial<ActionOption> => ({ free: undefined, token: menuToken(verb, target, other) });

  if (pick.kind === 'character') {
    const c = world.characters[pick.id];
    if (!c) return [];
    if (c.isPlayer) {
      const pose = bodyPose(world, c);
      if (c.seatId || pose !== 'de_pe') out.push(act('Levantar', 'levantar'));
      out.push({ label: 'Postura…', options: MENU_POSES.filter((p) => p !== pose).map((p) => act(POSES[p].label, 'pose', p)) });
      out.push({ label: 'Gesto…', options: MENU_GESTURES.map((g) => act(GESTURES[g].label, 'gesto', g)) });
      for (const i of [...new Set([hands.direita, hands.esquerda])].filter((x): x is Item => Boolean(x))) out.push(act(`Guardar ${i.name.toLowerCase()}`, 'guardar', i.id));
      return out;
    }
    const known = view.recognize(c.id);
    const name = known ? c.name.split(' ')[0] : strangerLabel(c);
    const d = c.pos ? distTo({ ...c.pos, w: 1, h: 1 }) : null;
    // Conversa livre: a próxima fala pronta, sem o mestre. "Falar" é para dizer algo e o mestre responder.
    if (nextLine(c)) out.push({ label: '💬 Conversar', free: { kind: 'talk', with: c.id }, note: hasNews(c) ? 'tem algo a dizer' : away(d) });
    out.push({ label: 'Falar', prefill: known ? `Digo a ${name}: "` : `Digo para ${name}: "` });
    out.push({ label: 'Sussurrar', prefill: known ? `@${name} "` : `@[${name}] "` });
    if (!known) out.push({ label: 'Perguntar o nome', prefill: `Pergunto para ${name}: "Desculpe, qual é o seu nome?"` });
    out.push({ label: 'Ir até', free: { kind: 'walk', near: c.id }, note: away(d) });
    out.push({ label: 'Gesto para…', options: MENU_GESTURES.filter((g) => GESTURES[g].face).map((g) => act(GESTURES[g].label, 'gesto', g, c.id)) });
    if (inventory.length) out.push({ label: 'Entregar…', options: inventory.map((i) => act(i.name, 'entregar', i.id, c.id)), note: away(d) });
    if (weapon) out.push(act(`Mirar com ${weapon.name.toLowerCase()}`, 'mirar', c.id));
    out.push(act(weapon ? `Atacar com ${weapon.name.toLowerCase()}` : 'Atacar', 'atacar', c.id, null, { note: weapon ? undefined : away(d) }));
    return out;
  }

  if (pick.kind === 'fixture') {
    const loc = locationOf(world, pick.id);
    const f = loc?.fixtures.find((x) => x.id === pick.id);
    if (!loc || !f || loc.id !== me.locationId) return [];
    const chain = typeChain(world, f.kind);
    const d = distTo(f);
    const exit = loc.exits?.[f.id];
    const article = objectType(world, f.kind).article ?? 'a';
    const by = `${article === 'o' ? 'pelo' : 'pela'} ${f.label}`;
    if (chain.some((t) => t.seat)) {
      const sitter = Object.values(world.characters).find((c) => c.seatId === f.id);
      const bed = chain.some((t) => t.bed);
      const taken = sitter && sitter.id !== me.id;
      if (sitter?.id !== me.id) {
        out.push(act(bed ? 'Deitar' : 'Sentar', bed ? 'deitar' : 'sentar', f.id, null, { disabled: Boolean(taken), note: taken ? `ocupado por ${shown(world, sitter!)}` : away(d) }));
      } else out.push(act('Levantar', 'levantar'));
    }
    if (exit && f.exit === 'floors') {
      const name = exit.label.replace(/["“”*()]/g, '').trim();
      out.push({ label: f.kind === 'stairs' ? 'Usar a escada' : f.kind === 'elevator' ? `Pegar ${name}` : `Usar ${f.label}`, prefill: `Vou ${by} até o andar ` });
    } else if (exit) {
      // Porta que já leva a um lugar conhecido: passa na hora. Para um lugar que ainda não existe, o mestre cria.
      const known = f.exit === 'door' && exit.to.length === 1 && Boolean(world.locations[exit.to[0]]);
      out.push(act(`Passar ${by}`, 'passar', f.id, null, { note: exit.to.length === 1 ? away(d) : 'o mestre decide aonde leva', ...(known ? {} : toMaster('passar', f.id)) }));
    }
    if (f.kind === 'board') out.push({ label: 'Escrever no quadro', prefill: 'Escrevo no quadro: ' });
    const surface = chain.some((t) => t.surface !== undefined || t.table);
    if (surface && inventory.length && !f.wall) out.push({ label: 'Pôr aqui…', options: inventory.map((i) => act(i.name, 'por', i.id, f.id)), note: away(d) });
    for (const verb of chain.find((t) => t.actions?.length)?.actions ?? []) out.push(act(verb[0].toUpperCase() + verb.slice(1), verbSlug(verb), f.id, null, { note: away(d) }));
    out.push({ label: `Ir até ${article} ${f.label}`, free: { kind: 'walk', near: f.id }, note: away(d) });
    return out;
  }

  const item = world.items[pick.id];
  if (!item) return [];
  const mine = item.holder.kind === 'character' && item.holder.id === me.id;
  const other = item.holder.kind === 'character' && !mine ? world.characters[item.holder.id] : null;
  const place = itemPlace(world, item);
  const d = place && place.locationId === me.locationId ? distTo(place.rect) : null;
  if (!mine && !other) out.push(act('Pegar', 'pegar', item.id, null, { note: away(d) }));
  if (mine) {
    const hand = item.holder.kind === 'character' && item.holder.hand;
    out.push(hand ? act('Guardar', 'guardar', item.id) : item.grip && item.grip !== 'objeto' ? act('Empunhar', 'empunhar', item.id, null, toMaster('empunhar', item.id)) : act('Segurar na mão', 'empunhar', item.id));
    out.push(act('Largar', 'largar', item.id));
    if (people.length) {
      out.push({
        label: 'Entregar para…',
        options: people.map((c) => act(shown(world, c), 'entregar', item.id, c.id, { note: away(distTo({ ...c.pos!, w: 1, h: 1 })) })),
      });
    }
  }
  if (item.text !== undefined && !other) out.push(act('Ler', 'ler', item.id, null, { note: mine ? undefined : away(d) }));
  if (item.light && !other) out.push(item.light.on ? act('Apagar', 'apagar', item.id) : act('Acender', 'acender', item.id));
  return out;
}
