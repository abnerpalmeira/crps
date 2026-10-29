import { conditionDefsOf, grantsOf, perkDefsOf } from './effects';
import { lightAt, type LightSource } from './light';
import { chebyshev } from './text';
import type { PerkDef, PerkGrant, Pos, SpeechMode, VisionRules, WorldState } from './types';

/** Quanto alguém enxerga de algo: nítido, só um vulto, ou nada. */
export type Sight = 'nitido' | 'vulto' | 'nada';

export const DEFAULT_VISION: VisionRules = { clear: 0.35, dim: 0.12, dimPenalty: 1, blindPenalty: 3 };

/** O que um personagem (em geral o do jogador) consegue perceber dos outros. */
export interface Perception {
  perks: PerkDef[];
  conditions: PerkDef[];
  canSeeStat(statId: string, targetId: string): boolean;
  canSeeThoughts(targetId: string): boolean;
  sight(targetId: string): Sight;
}

/** Id do recurso universal de vida (o mestre pode tê-lo chamado de "hp", por exemplo). */
export function lifeStatId(world: WorldState): string | null {
  return world.ruleset.resources.find((r) => r.core)?.id ?? null;
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
 * multiplicador de perk que toque no canal, mais a soma dos bônus em tiles; condições (e perks)
 * com `factor` multiplicam o alcance final. `perks: false` calcula só com as condições.
 */
export function senseOf(
  world: WorldState,
  characterId: string,
  channel: string,
  opts: { perks?: boolean } = {},
): { multiplier: number; bonus: number; factor: number } {
  const grants = grantsOf(world, characterId, opts);
  const sense = grants.filter((g): g is Extract<PerkGrant, { kind: 'sense' }> => g.kind === 'sense' && g.channel === channel);
  const multipliers = sense.flatMap((g) => (g.multiplier === undefined ? [] : [g.multiplier]));
  const multiplier = multipliers.length ? Math.max(...multipliers) : (world.ruleset.senses?.[channel] ?? 0);
  // see_thoughts (versão antiga de "ler mente") vale como mente na sala inteira.
  const legacyMind = channel === 'mente' && grants.some((g) => g.kind === 'see_thoughts') ? 99 : 0;
  return {
    multiplier,
    bonus: sense.reduce((sum, g) => sum + (g.bonus ?? 0), 0) + legacyMind,
    factor: sense.reduce((f, g) => f * (g.factor ?? 1), 1),
  };
}

/**
 * O receptor percebe algo emitido por `sourceId` num canal com alcance base `range`? Canais
 * visuais (ler lábios) também exigem enxergar a fonte com nitidez.
 */
export function perceives(
  world: WorldState,
  receiverId: string,
  sourceId: string,
  channel: string,
  range: number,
  opts: { perks?: boolean } = {},
): boolean {
  if (receiverId === sourceId) return true;
  const d = distanceBetween(world, receiverId, sourceId);
  if (d === null) return false;
  const { multiplier, bonus, factor } = senseOf(world, receiverId, channel, opts);
  if ((multiplier <= 0 && bonus <= 0) || factor <= 0) return false;
  if (d > (range * multiplier + bonus) * factor) return false;
  return !world.ruleset.sightChannels?.includes(channel) || sightOf(world, receiverId, sourceId) === 'nitido';
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
  if (receiverId === speakerId || distanceBetween(world, receiverId, speakerId) === null) return [];
  const channels: [string, number][] = [...Object.entries(mode.channels), ['mente', 0]];
  if (channels.some(([channel, range]) => perceives(world, receiverId, speakerId, channel, range, { perks: false }))) return [];
  const used = new Set(channels.filter(([channel, range]) => perceives(world, receiverId, speakerId, channel, range)).map(([channel]) => channel));
  return perkDefsOf(world, receiverId).filter((p) =>
    p.grants.some((g) => (g.kind === 'sense' && used.has(g.channel)) || (g.kind === 'see_thoughts' && used.has('mente'))),
  );
}

export function visionRules(world: WorldState): VisionRules {
  return world.ruleset.vision ?? DEFAULT_VISION;
}

/** Acuidade (1 = normal, 0 = cego) e visão no escuro (tiles em que a luz não importa). */
export function visionOf(world: WorldState, viewerId: string): { acuity: number; darkvision: number } {
  const { multiplier, bonus, factor } = senseOf(world, viewerId, 'visao');
  return { acuity: Math.max(0, multiplier * factor), darkvision: Math.max(0, bonus * factor) };
}

/**
 * O quanto `viewerId` enxerga um tile. Clareza = luz no tile × acuidade, caindo com a distância
 * até o fim do alcance da visão (reaches.visao × acuidade); dentro da visão no escuro, nítido.
 */
export function sightAt(world: WorldState, viewerId: string, locationId: string, pos: Pos, sources?: LightSource[]): Sight {
  const viewer = world.characters[viewerId];
  if (!viewer?.pos || viewer.locationId !== locationId) return 'nada';
  const { acuity, darkvision } = visionOf(world, viewerId);
  const d = chebyshev(viewer.pos, pos);
  if (darkvision > 0 && d <= darkvision) return 'nitido';
  const range = (world.ruleset.reaches?.visao ?? 40) * acuity;
  if (acuity <= 0 || d > range) return 'nada';
  const clarity = lightAt(world, locationId, pos, sources) * Math.min(acuity, 1) * (1 - d / (range + 1));
  const { clear, dim } = visionRules(world);
  return clarity >= clear ? 'nitido' : clarity >= dim ? 'vulto' : 'nada';
}

/** O quanto um personagem enxerga outro agora. */
export function sightOf(world: WorldState, viewerId: string, targetId: string): Sight {
  if (viewerId === targetId) return 'nitido';
  const target = world.characters[targetId];
  if (!target?.pos || !target.locationId) return 'nada';
  return sightAt(world, viewerId, target.locationId, target.pos);
}

export function perceptionOf(world: WorldState, viewerId: string | null): Perception {
  const perks = perkDefsOf(world, viewerId);
  const seeStats = new Set(grantsOf(world, viewerId).flatMap((g) => (g.kind === 'see_stat' ? [g.stat] : [])));
  const defs = [...world.ruleset.attributes, ...world.ruleset.resources];
  return {
    perks,
    conditions: conditionDefsOf(world, viewerId),
    canSeeStat(statId, targetId) {
      const def = defs.find((d) => d.id === statId);
      if (!def) return false;
      if (def.visibility === 'public' || seeStats.has(statId)) return true;
      return def.visibility === 'self' && targetId === viewerId;
    },
    canSeeThoughts: (targetId) => Boolean(viewerId) && targetId !== viewerId && perceives(world, viewerId!, targetId, 'mente', 0),
    sight: (targetId) => (viewerId ? sightOf(world, viewerId, targetId) : 'nitido'),
  };
}
