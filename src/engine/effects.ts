import type { MovementRules, PerkDef, PerkGrant, WorldState } from './types';

/** Passos por turno de todo personagem, quando o ruleset não diz outro número. */
export const DEFAULT_MOVEMENT: MovementRules = { steps: 8 };

/**
 * Passos por turno de quem anda pelo grid sem o mestre: a base do ruleset, o que o atributo dele
 * soma, e os efeitos `move` de perks e condições (bonus soma, factor multiplica).
 */
export function stepsFor(world: WorldState, characterId: string): number {
  const c = world.characters[characterId];
  if (!c) return 0;
  const rules = world.ruleset.movement ?? DEFAULT_MOVEMENT;
  const attr = rules.attribute ? world.ruleset.attributes.find((a) => a.id === rules.attribute) : undefined;
  let steps = rules.steps + (attr ? (c.attributes[attr.id] ?? attr.default) * (rules.perPoint ?? 1) : 0);
  let factor = 1;
  for (const g of grantsOf(world, characterId)) {
    if (g.kind !== 'move') continue;
    steps += g.bonus ?? 0;
    factor *= g.factor ?? 1;
  }
  return Math.max(0, Math.floor(steps * factor));
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
