import type { Character, ReadyLine } from './types';

/** A próxima fala pronta: as do turno na ordem, depois as gerais em rodízio; sem gerais, repete a última. */
export function nextLine(c: Character): ReadyLine | null {
  const { turn = [], general = [], heard = 0 } = c.lines ?? {};
  if (heard < turn.length) return turn[heard];
  if (general.length) return general[(heard - turn.length) % general.length];
  return turn.at(-1) ?? null;
}

/** O NPC tem fala do turno que o jogador ainda não ouviu: o 3D mostra 💬 sobre ele. */
export function hasNews(c: Character): boolean {
  return Boolean(c.lines && c.lines.heard < c.lines.turn.length);
}
