import { stripActs } from './body';
import { parseSpeechLine } from './frames';
import { sightAt } from './perception';
import { distanceToRect, fold } from './text';
import type { Character, Item, Pos, WorldState } from './types';

/**
 * Leitura na narração: o texto de um bilhete, carta, livro ou placa vai numa linha própria, como a
 * fala do item, `@id_do_item[>leitor]: texto`. Na primeira leitura o motor guarda o texto no item
 * (e ele vira um fato que quem lê passa a saber); depois, toda leitura repete o mesmo texto.
 */
export interface ReadingLine {
  /** Índice da linha na narração. */
  index: number;
  itemId: string;
  readerId: string;
  /** O que a linha diz, sem marcas de gesto nem aspas em volta. */
  text: string;
}

/** Onde o item está fisicamente: o local e o retângulo (o tile, o móvel ou quem o carrega). */
export function itemPlace(world: WorldState, item: Item): { locationId: string; rect: { x: number; y: number; w: number; h: number } } | null {
  const h = item.holder;
  if (h.kind === 'ground') return { locationId: h.locationId, rect: { x: h.x, y: h.y, w: 1, h: 1 } };
  if (h.kind === 'fixture') {
    for (const loc of Object.values(world.locations)) {
      const f = loc.fixtures.find((x) => x.id === h.id);
      if (f) return { locationId: loc.id, rect: f };
    }
    return null;
  }
  const c = world.characters[h.id];
  return c?.locationId && c.pos ? { locationId: c.locationId, rect: { ...c.pos, w: 1, h: 1 } } : null;
}

/** Quem lê: o leitor marcado; sem ele, quem está com o item; senão, o personagem do jogador. */
export function readerOf(world: WorldState, item: Item, targetId: string | null): Character | null {
  if (targetId) return world.characters[targetId] ?? null;
  if (item.holder.kind === 'character') return world.characters[item.holder.id] ?? null;
  return world.playerId ? (world.characters[world.playerId] ?? null) : null;
}

/** O texto da linha sem marcas de gesto e sem as aspas em volta. */
export function readingText(text: string): string {
  return stripActs(text)
    .replace(/^["“”«»'\s]+|["“”«»'\s]+$/g, '')
    .trim();
}

const norm = (s: string) =>
  fold(s)
    .replace(/[«»“”"'.,!?;:…()\-—–]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Confere as leituras da narração: o item existe, quem lê está com ele ou colado nele, enxerga o
 * bastante para ler, e o texto bate com o que já está escrito (ou um trecho dele).
 */
export function analyzeReading(world: WorldState, narration: string): { issues: string[]; lines: ReadingLine[] } {
  const issues: string[] = [];
  const lines: ReadingLine[] = [];
  narration.split('\n').forEach((raw, index) => {
    const p = parseSpeechLine(raw);
    const item = p ? world.items[p.speakerId] : undefined;
    if (!p || !item || p.hidden) return;
    const reader = readerOf(world, item, p.targetId);
    if (!reader) {
      issues.push(`A leitura de ${item.name} (@${item.id}) aponta "${p.targetId}" como leitor, e esse id não é de personagem.`);
      return;
    }
    const place = itemPlace(world, item);
    if (!place || !reader.pos || reader.locationId !== place.locationId) {
      issues.push(`${reader.name} não está onde ${item.name} está para ler. Leve um até o outro antes (move_character ou transfer_item).`);
      return;
    }
    const held = item.holder.kind === 'character' && item.holder.id === reader.id;
    const d = distanceToRect(reader.pos, place.rect);
    if (!held && d > 1) {
      issues.push(`${reader.name} está a ${d} tiles de ${item.name}: para ler, pegue o item (transfer_item) ou chegue perto (move_character).`);
      return;
    }
    const spot: Pos = { x: place.rect.x + Math.floor((place.rect.w - 1) / 2), y: place.rect.y + Math.floor((place.rect.h - 1) / 2) };
    if (!held && sightAt(world, reader.id, place.locationId, spot) !== 'nitido') {
      issues.push(`${reader.name} não enxerga ${item.name} bem o bastante para ler (escuro ou visão ruim). Traga luz antes, ou narre que não dá para ler.`);
      return;
    }
    if (held && sightAt(world, reader.id, place.locationId, reader.pos) !== 'nitido') {
      issues.push(`${reader.name} não enxerga bem o bastante para ler ${item.name} (escuro ou visão ruim). Traga luz antes, ou narre que não dá para ler.`);
      return;
    }
    const text = readingText(p.text);
    if (typeof item.text === 'string' && !norm(item.text).includes(norm(text))) {
      issues.push(`${item.name} já tem escrito «${item.text}». Ao ler, repita esse texto (ou um trecho dele) na linha @${item.id}.`);
      return;
    }
    lines.push({ index, itemId: item.id, readerId: reader.id, text });
  });
  return { issues, lines };
}
