import type { MovementRules, PerkDef, PerkGrant, TimeRules, WorldState } from './types';

/** Velocidade a pé de todo personagem, quando o ruleset não diz outra: uma casa (cerca de 1 m) por segundo. */
export const DEFAULT_MOVEMENT: MovementRules = { speed: 1 };

/** Quanto cada ponto do atributo de movimento soma de velocidade, quando o ruleset não diz outro. */
export const DEFAULT_PER_POINT = 0.1;

/** Quanto cada tipo de ação gasta do tempo do turno, em segundos, quando o ruleset não diz outro. */
export const DEFAULT_TIME: TimeRules = { talk: 5, act: 2 };

/**
 * Casas por segundo de quem anda pelo grid sem o mestre: a base do ruleset, o que o atributo dele
 * soma, e os efeitos `move` de perks e condições (bonus soma, factor multiplica).
 */
export function speedFor(world: WorldState, characterId: string): number {
  const c = world.characters[characterId];
  if (!c) return 0;
  const rules = world.ruleset.movement ?? DEFAULT_MOVEMENT;
  const attr = rules.attribute ? world.ruleset.attributes.find((a) => a.id === rules.attribute) : undefined;
  let speed = rules.speed + (attr ? (c.attributes[attr.id] ?? attr.default) * (rules.perPoint ?? DEFAULT_PER_POINT) : 0);
  let factor = 1;
  for (const g of grantsOf(world, characterId)) {
    if (g.kind !== 'move') continue;
    speed += g.bonus ?? 0;
    factor *= g.factor ?? 1;
  }
  return Math.max(0, speed * factor);
}

/** Segundos que o jogador ainda tem no grid neste turno. */
export function timeLeft(world: WorldState): number {
  const { budget, spent } = world.turnClock;
  return Math.max(0, budget - spent);
}

/** Segundos que uma ação livre gasta: cada fala ouvida (`talk`) ou um verbo do menu. */
export function costOf(world: WorldState, action: string): number {
  const time = world.ruleset.time ?? DEFAULT_TIME;
  return action === 'talk' ? time.talk : (time.verbs?.[action] ?? time.act);
}

/**
 * Se o tempo que resta não dá para nada no grid: nem uma casa, nem uma fala, nem a ação mais rápida.
 * Daí em diante, só o mestre narra.
 */
export function timeUp(world: WorldState, characterId: string): boolean {
  const time = world.ruleset.time ?? DEFAULT_TIME;
  const speed = speedFor(world, characterId);
  const quickest = Math.min(time.talk, time.act, ...Object.values(time.verbs ?? {}), speed > 0 ? 1 / speed : Infinity);
  return timeLeft(world) + 1e-9 < quickest;
}

/** Até quantas casas o personagem anda com o tempo que resta no turno. */
export function walkRange(world: WorldState, characterId: string): number {
  // A folga absorve o erro de ponto flutuante: 3 s a 1 casa/s são 3 casas, não 2.
  return Math.floor(timeLeft(world) * speedFor(world, characterId) + 1e-9);
}

/** Perks do personagem, na ordem em que ele os ganhou. */
export function perkDefsOf(world: WorldState, characterId: string | null): PerkDef[] {
  const c = characterId ? world.characters[characterId] : undefined;
  return (c?.perks ?? []).flatMap((id) => world.ruleset.perks.filter((p) => p.id === id));
}

/** Condições ativas do personagem (cego, visão turva…). */
export function conditionDefsOf(world: WorldState, characterId: string | null): PerkDef[] {
  const c = characterId ? world.characters[characterId] : undefined;
  return (c?.conditions ?? []).flatMap((a) => (world.ruleset.conditions ?? []).filter((d) => d.id === a.id));
}

/** Efeitos mecânicos sobre o personagem: dos perks (salvo `perks: false`) e das condições. */
export function grantsOf(world: WorldState, characterId: string | null, opts: { perks?: boolean } = {}): PerkGrant[] {
  const defs = [...(opts.perks === false ? [] : perkDefsOf(world, characterId)), ...conditionDefsOf(world, characterId)];
  return defs.flatMap((d) => d.grants);
}
