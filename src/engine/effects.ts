import type { PerkDef, PerkGrant, WorldState } from './types';

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
