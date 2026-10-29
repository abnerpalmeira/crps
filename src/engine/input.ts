import { fold } from './text';
import type { Character, WorldState } from './types';

/**
 * Marcas na ação do jogador, com convenções de livro e de chat: "fala" entre aspas (ou — fala
 * no começo da linha), *ação* entre asteriscos, (pensamento) entre parênteses e @Nome "sussurro".
 * Texto sem marca é ação ou intenção, como sempre foi.
 */
export type InputKind = 'fala' | 'sussurro' | 'pensamento' | 'acao';

export interface InputSegment {
  kind: InputKind;
  text: string;
  /** Para quem é o sussurro, como o jogador escreveu (nome ou id). */
  target?: string;
  /** Texto sem marca (ação ou intenção livre). */
  free?: boolean;
}

const PAIRS: Record<string, [close: string, kind: InputKind]> = {
  '"': ['"', 'fala'],
  '“': ['”', 'fala'],
  '*': ['*', 'acao'],
  '(': [')', 'pensamento'],
};

/** Palavras que só ligam as partes ("digo", "e então") e não são uma ação. */
const GLUE = new Set(['e', 'entao', 'ai', 'depois', 'mas', 'enquanto', 'logo', 'eu', 'digo', 'falo', 'pergunto', 'respondo', 'penso', 'sussurro', 'cochicho']);

const WHISPER = /^@([\p{L}\p{N}_-]+)\s*[:,]?\s*(["“])/u;

export function parsePlayerInput(input: string): InputSegment[] {
  const out: InputSegment[] = [];
  const push = (segment: InputSegment) => {
    if (segment.text) out.push(segment);
  };
  const free = (raw: string) => {
    const text = raw.trim().replace(/^[,;:–—-]+\s*/, '').replace(/\s*[,;:–—-]+$/, '');
    const words = fold(text).replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
    if (words.length && !words.every((w) => GLUE.has(w))) push({ kind: 'acao', text, free: true });
  };
  for (const line of input.split('\n')) {
    // Travessão no começo da linha: a linha inteira é fala, como no diálogo de livro.
    const dash = /^\s*[—–-]\s+(.+)$/.exec(line);
    if (dash) {
      push({ kind: 'fala', text: dash[1].trim() });
      continue;
    }
    let pending = '';
    let i = 0;
    while (i < line.length) {
      const whisper = line[i] === '@' ? WHISPER.exec(line.slice(i)) : null;
      const pair = PAIRS[line[i]];
      if (!whisper && !pair) {
        pending += line[i++];
        continue;
      }
      free(pending);
      pending = '';
      // Marca sem fechamento vai até o fim da linha.
      const start = whisper ? i + whisper[0].length : i + 1;
      const close = whisper ? (whisper[2] === '“' ? '”' : '"') : pair![0];
      const end = line.indexOf(close, start);
      const text = line.slice(start, end < 0 ? undefined : end).trim();
      push(whisper ? { kind: 'sussurro', target: whisper[1], text } : { kind: pair![1], text });
      i = end < 0 ? line.length : end + 1;
    }
    free(pending);
  }
  return out;
}

/** O jogador usou alguma marca? Sem nenhuma, a ação vai ao mestre como texto livre, como antes. */
export function hasMarks(segments: InputSegment[]): boolean {
  return segments.some((s) => !s.free);
}

/** Personagem pelo id, nome completo ou primeiro nome, de preferência no mesmo local do jogador. */
export function findByName(world: WorldState, ref: string): Character | null {
  const f = fold(ref);
  const here = world.playerId ? world.characters[world.playerId]?.locationId : null;
  const matches = Object.values(world.characters).filter(
    (c) => !c.isPlayer && (c.id === f || fold(c.name) === f || fold(c.name.split(' ')[0]) === f),
  );
  return matches.find((c) => c.locationId === here) ?? matches[0] ?? null;
}

/** As partes marcadas, uma por linha, para o mestre não confundir fala, pensamento e ação. */
export function describeInput(world: WorldState, segments: InputSegment[]): string[] {
  return segments.map((s) => {
    if (s.kind === 'fala') return `- fala (em voz alta): "${s.text}"`;
    if (s.kind === 'pensamento') return `- pensamento (só na cabeça dele): ${s.text}`;
    if (s.kind === 'acao') return `- ação: ${s.text}`;
    const target = findByName(world, s.target ?? '');
    return target
      ? `- sussurro para ${target.name} [${target.id}]: "${s.text}"`
      : `- sussurro para "${s.target}" (ninguém com esse nome aqui): "${s.text}"`;
  });
}
