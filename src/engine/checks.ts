import { knowsName, recognitionOf } from './perception';
import type { Character, WorldState } from './types';

/**
 * Conferências da narração que o código faz sozinho, sem modelo: o que é exato (um nome escrito,
 * uma fala repetida) não precisa de julgamento.
 */

/** Partículas que não identificam ninguém ("de", "da", "dos"…). */
const PARTICLES = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'del', 'van', 'von', 'la', 'le']);

/** O texto como o jogador o lê: sem o prefixo `@id[...]:` das falas e sem as marcas `{...}`. */
export function readableText(text: string): string {
  return text.replace(/^\s*@[\w/-]+(\[[^\]]*\])?:\s*/gm, '').replace(/\{[^}]*\}/g, '');
}

/** As partes do nome que identificam a pessoa (primeiro nome, sobrenome), sem partículas. */
export function nameParts(c: Character): string[] {
  return c.name.split(/\s+/).filter((p) => p.length >= 3 && !PARTICLES.has(p.toLowerCase()));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (s: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(s)}(?![\\p{L}\\p{N}])`, 'u');

/** O texto tem a palavra inteira (com maiúsculas e acentos como estão). */
export function hasWord(text: string, w: string): boolean {
  return word(w).test(text);
}

/**
 * Nome indevido: o texto chama pelo nome alguém que o jogador não conhece, ou que conhece mas não
 * reconhece agora (no escuro, disfarçado). O nome na boca de um NPC também conta: o jogador ouviria,
 * e isso pede introduce. `except` é quem pode dizer o próprio nome (a fala marcada "diz o nome").
 * Uma parte do nome que duas pessoas têm (o sobrenome de um casal) só conta com o nome inteiro.
 */
export function nameLeaks(world: WorldState, text: string, except: string | null = null): { who: Character; name: string }[] {
  const playerId = world.playerId;
  const player = playerId ? world.characters[playerId] : null;
  if (!player) return [];
  const prose = readableText(text);
  const all = Object.values(world.characters);
  const shared = new Set(
    all
      .flatMap((c) => [...new Set(nameParts(c))])
      .filter((p, i, list) => list.indexOf(p) !== i),
  );
  const leaks: { who: Character; name: string }[] = [];
  for (const c of all) {
    if (c.isPlayer || c.id === except) continue;
    const present = player.locationId !== null && c.locationId === player.locationId;
    if (knowsName(world, player.id, c.id) && !(present && recognitionOf(world, player.id, c.id) === null)) continue;
    const name = word(c.name).test(prose) ? c.name : nameParts(c).find((p) => !shared.has(p) && word(p).test(prose));
    if (name) leaks.push({ who: c, name });
  }
  return leaks;
}

/** Palavras de uma fala para comparar: minúsculas, sem acento, só as de quatro letras ou mais. */
function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4),
  );
}

/** A fala repete o que a pessoa já disse: metade ou mais das palavras dela está numa das falas ditas. */
export function repeats(line: string, said: string[]): boolean {
  const mine = words(line);
  if (mine.size < 3) return false;
  return said.some((s) => {
    const theirs = words(s);
    let common = 0;
    for (const w of mine) if (theirs.has(w)) common++;
    return common / mine.size >= 0.5;
  });
}

/**
 * Tira das falas do turno as que repetem o que a pessoa acabou de dizer na narração: o jogador já
 * ouviu, e puxar conversa não pode tocar de novo. Devolve quantas saíram.
 */
export function dropRepeated(c: Character, said: string[]): number {
  if (!c.lines?.turn.length || !said.length) return 0;
  const kept = c.lines.turn.filter((line) => !repeats(line.text, said));
  const dropped = c.lines.turn.length - kept.length;
  c.lines.turn = kept;
  return dropped;
}
