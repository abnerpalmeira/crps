import type { PerkDef, WorldState } from './types';

/** O que um personagem (em geral o do jogador) consegue perceber dos outros. */
export interface Perception {
  perks: PerkDef[];
  canSeeStat(statId: string, targetId: string): boolean;
  canSeeThoughts(targetId: string): boolean;
}

/** Id do recurso universal de vida (o mestre pode tê-lo chamado de "hp", por exemplo). */
export function lifeStatId(world: WorldState): string | null {
  return world.ruleset.resources.find((r) => r.core)?.id ?? null;
}

export function perceptionOf(world: WorldState, viewerId: string | null): Perception {
  const viewer = viewerId ? world.characters[viewerId] : undefined;
  const perks = (viewer?.perks ?? []).flatMap((id) => world.ruleset.perks.filter((p) => p.id === id));
  const grants = perks.flatMap((p) => p.grants);
  const seeStats = new Set(grants.flatMap((g) => (g.kind === 'see_stat' ? [g.stat] : [])));
  const seeThoughts = grants.some((g) => g.kind === 'see_thoughts');
  const defs = [...world.ruleset.attributes, ...world.ruleset.resources];
  return {
    perks,
    canSeeStat(statId, targetId) {
      const def = defs.find((d) => d.id === statId);
      if (!def) return false;
      if (def.visibility === 'public' || seeStats.has(statId)) return true;
      return def.visibility === 'self' && targetId === viewerId;
    },
    canSeeThoughts: (targetId) => seeThoughts && targetId !== viewerId,
  };
}
