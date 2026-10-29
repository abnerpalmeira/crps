import type { SceneFrame, WorldState } from './types';

/** Um passo do replay de um turno: a ação do jogador, uma fala ou um trecho de narração. */
export type Beat =
  | { kind: 'input'; text: string }
  | { kind: 'speech'; speakerId: string; text: string; mode: string; targetId: string | null; hidden: boolean; via: string | null; alias: string | null; toAlias: string | null }
  | { kind: 'narration'; text: string };

/**
 * Fala na narração do mestre: `@id: texto`, `@id[>alvo]: texto`, `@id[cochicho>alvo]: texto`.
 * Na versão do jogador, notas depois de `|`: `oculto` marca a fala que ele não ouviu (o texto
 * vira só o gesto), `via Perk` a que ele só percebeu graças a um perk, e `como …` e `para …` como
 * ele chama quem fala e o alvo quando não sabe quem são.
 */
export const SPEECH_LINE = /^\s*@([a-z0-9_]+)(?:\[([a-z0-9_]*)(?:>([a-z0-9_]+))?(?:\|([^\]]+))?\])?\s*:\s*(.+)$/i;

export interface ParsedSpeech {
  speakerId: string;
  mode: string;
  targetId: string | null;
  hidden: boolean;
  via: string | null;
  /** Como o jogador chama quem fala, quando não sabe quem é ("uma voz de homem"). */
  alias: string | null;
  /** Como o jogador chama o alvo, quando não sabe quem é. */
  toAlias: string | null;
  text: string;
}

export function parseSpeechLine(line: string): ParsedSpeech | null {
  const m = SPEECH_LINE.exec(line);
  if (!m) return null;
  const notes = (m[4] ?? '').split('|').map((n) => n.trim());
  const note = (prefix: string) => notes.find((n) => n.startsWith(prefix))?.slice(prefix.length).trim() || null;
  return {
    speakerId: m[1].toLowerCase(),
    mode: (m[2] || 'fala').toLowerCase(),
    targetId: m[3]?.toLowerCase() ?? null,
    hidden: notes.includes('oculto'),
    via: note('via '),
    alias: note('como '),
    toAlias: note('para '),
    text: m[5].trim(),
  };
}

export const MAX_FRAMES = 400;
const MAX_CAPTION = 240;

/** Quebra um parágrafo longo em legendas, sempre em fim de frase. */
function captions(text: string): string[] {
  const sentences = text.match(/[^.!?…]+[.!?…]+["”»)*]*\s*|[^.!?…]+$/g) ?? [text];
  const out: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && (current + sentence).length > MAX_CAPTION) {
      out.push(current.trim());
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** Narração do mestre → falas e trechos de narração, na ordem em que acontecem. */
export function parseBeats(narration: string): Beat[] {
  const beats: Beat[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) for (const text of captions(paragraph.join(' '))) beats.push({ kind: 'narration', text });
    paragraph = [];
  };
  for (const line of narration.split('\n')) {
    const speech = parseSpeechLine(line);
    if (speech) {
      flush();
      beats.push({ kind: 'speech', ...speech });
    } else if (line.trim()) paragraph.push(line.trim());
    else flush();
  }
  flush();
  return beats;
}

export function snapshotScene(world: WorldState): SceneFrame {
  return {
    turn: world.turn,
    clock: { ...world.clock },
    characters: Object.fromEntries(
      Object.values(world.characters).map((c) => [
        c.id,
        {
          locationId: c.locationId,
          pos: c.pos && { ...c.pos },
          seatId: c.seatId,
          facing: c.facing,
          resources: { ...c.resources },
          conditions: structuredClone(c.conditions),
        },
      ]),
    ),
    items: Object.fromEntries(Object.values(world.items).map((i) => [i.id, structuredClone(i.holder)])),
    fixtures: Object.fromEntries(
      Object.values(world.locations)
        .flatMap((l) => l.fixtures)
        .filter((f) => f.text || f.state)
        .map((f) => [f.id, { text: f.text, state: f.state }]),
    ),
    light: {
      locations: Object.fromEntries(Object.values(world.locations).map((l) => [l.id, l.light])),
      items: Object.fromEntries(Object.values(world.items).flatMap((i) => (i.light ? [[i.id, i.light.on]] : []))),
    },
  };
}

/** O mundo como estava no retrato: posições, itens, quadro, luz e relógio. Sem retrato, o mundo atual. */
export function sceneAt(world: WorldState, frame: SceneFrame | undefined): WorldState {
  if (!frame) return world;
  const w = structuredClone(world);
  w.turn = frame.turn;
  w.clock = { ...frame.clock };
  w.characters = Object.fromEntries(
    Object.entries(w.characters)
      .filter(([id]) => frame.characters[id])
      .map(([id, c]) => [id, { ...c, ...frame.characters[id] }]),
  );
  w.items = Object.fromEntries(
    Object.entries(w.items)
      .filter(([id]) => frame.items[id])
      .map(([id, i]) => {
        const on = frame.light?.items[id];
        return [id, { ...i, holder: frame.items[id], ...(i.light && on !== undefined ? { light: { ...i.light, on } } : {}) }];
      }),
  );
  for (const l of Object.values(w.locations)) l.light = frame.light?.locations[l.id] ?? l.light;
  for (const f of Object.values(w.locations).flatMap((l) => l.fixtures)) {
    f.text = frame.fixtures[f.id]?.text ?? '';
    f.state = frame.fixtures[f.id]?.state ?? '';
  }
  return w;
}
