import { chebyshev } from './text';
import type { PerkDef, PerkGrant, SpeechMode, WorldState } from './types';

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

function perksOf(world: WorldState, characterId: string | null): PerkDef[] {
  const c = characterId ? world.characters[characterId] : undefined;
  return (c?.perks ?? []).flatMap((id) => world.ruleset.perks.filter((p) => p.id === id));
}

/** Distância em tiles entre dois personagens no mesmo local; null se não estão juntos. */
export function distanceBetween(world: WorldState, a: string, b: string): number | null {
  const ca = world.characters[a];
  const cb = world.characters[b];
  if (!ca?.pos || !cb?.pos || !ca.locationId || ca.locationId !== cb.locationId) return null;
  return chebyshev(ca.pos, cb.pos);
}

/**
 * Sentido de um personagem num canal: o multiplicador base das regras, substituído pelo maior
 * multiplicador de perk que toque no canal, mais a soma dos bônus em tiles.
 */
export function senseOf(world: WorldState, characterId: string, channel: string): { multiplier: number; bonus: number } {
  const grants = perksOf(world, characterId).flatMap((p) => p.grants);
  const sense = grants.filter((g): g is Extract<PerkGrant, { kind: 'sense' }> => g.kind === 'sense' && g.channel === channel);
  const multipliers = sense.flatMap((g) => (g.multiplier === undefined ? [] : [g.multiplier]));
  const multiplier = multipliers.length ? Math.max(...multipliers) : (world.ruleset.senses?.[channel] ?? 0);
  // see_thoughts (versão antiga de "ler mente") vale como mente na sala inteira.
  const legacyMind = channel === 'mente' && grants.some((g) => g.kind === 'see_thoughts') ? 99 : 0;
  return { multiplier, bonus: sense.reduce((sum, g) => sum + (g.bonus ?? 0), 0) + legacyMind };
}

/** O receptor percebe algo emitido por `sourceId` num canal com alcance base `range`? */
export function perceives(world: WorldState, receiverId: string, sourceId: string, channel: string, range: number): boolean {
  if (receiverId === sourceId) return true;
  const d = distanceBetween(world, receiverId, sourceId);
  if (d === null) return false;
  const { multiplier, bonus } = senseOf(world, receiverId, channel);
  if (multiplier <= 0 && bonus <= 0) return false;
  return d <= range * multiplier + bonus;
}

/** Ouve (ou lê nos lábios, ou na mente de quem fala) o conteúdo de uma fala? */
export function perceivesSpeech(world: WorldState, receiverId: string, speakerId: string, mode: SpeechMode): boolean {
  for (const [channel, range] of Object.entries(mode.channels)) {
    if (perceives(world, receiverId, speakerId, channel, range)) return true;
  }
  // O conteúdo também está na mente de quem fala.
  return perceives(world, receiverId, speakerId, 'mente', 0);
}

/**
 * Perks graças aos quais o receptor percebe uma fala; vazio se os sentidos comuns bastam
 * (ou se ele não percebe).
 */
export function speechPerks(world: WorldState, receiverId: string, speakerId: string, mode: SpeechMode): PerkDef[] {
  const d = distanceBetween(world, receiverId, speakerId);
  if (d === null || receiverId === speakerId) return [];
  const channels: [string, number][] = [...Object.entries(mode.channels), ['mente', 0]];
  if (channels.some(([channel, range]) => d <= range * (world.ruleset.senses?.[channel] ?? 0))) return [];
  const used = new Set(channels.filter(([channel, range]) => perceives(world, receiverId, speakerId, channel, range)).map(([channel]) => channel));
  return perksOf(world, receiverId).filter((p) =>
    p.grants.some((g) => (g.kind === 'sense' && used.has(g.channel)) || (g.kind === 'see_thoughts' && used.has('mente'))),
  );
}

export function perceptionOf(world: WorldState, viewerId: string | null): Perception {
  const perks = perksOf(world, viewerId);
  const seeStats = new Set(perks.flatMap((p) => p.grants).flatMap((g) => (g.kind === 'see_stat' ? [g.stat] : [])));
  const defs = [...world.ruleset.attributes, ...world.ruleset.resources];
  return {
    perks,
    canSeeStat(statId, targetId) {
      const def = defs.find((d) => d.id === statId);
      if (!def) return false;
      if (def.visibility === 'public' || seeStats.has(statId)) return true;
      return def.visibility === 'self' && targetId === viewerId;
    },
    canSeeThoughts: (targetId) => Boolean(viewerId) && targetId !== viewerId && perceives(world, viewerId!, targetId, 'mente', 0),
  };
}
