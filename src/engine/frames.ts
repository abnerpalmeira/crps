import type { SceneFrame, WorldState } from './types';

/** Um passo do replay de um turno: a ação do jogador, uma fala ou um trecho de narração. */
export type Beat =
  | { kind: 'input'; text: string }
  | { kind: 'speech'; speakerId: string; text: string }
  | { kind: 'narration'; text: string };

/** Fala na narração do mestre: uma linha `@id: texto`. */
export const SPEECH_LINE = /^\s*@([a-z0-9_]+)\s*:\s*(.+)$/i;

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
    const speech = SPEECH_LINE.exec(line);
    if (speech) {
      flush();
      beats.push({ kind: 'speech', speakerId: speech[1].toLowerCase(), text: speech[2].trim() });
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
        { locationId: c.locationId, pos: c.pos && { ...c.pos }, seatId: c.seatId, facing: c.facing, resources: { ...c.resources } },
      ]),
    ),
    items: Object.fromEntries(Object.values(world.items).map((i) => [i.id, structuredClone(i.holder)])),
    fixtures: Object.fromEntries(
      Object.values(world.locations)
        .flatMap((l) => l.fixtures)
        .filter((f) => f.text || f.state)
        .map((f) => [f.id, { text: f.text, state: f.state }]),
    ),
  };
}

/** O mundo como estava no retrato: posições, itens, quadro e relógio. Sem retrato, o mundo atual. */
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
      .map(([id, i]) => [id, { ...i, holder: frame.items[id] }]),
  );
  for (const f of Object.values(w.locations).flatMap((l) => l.fixtures)) {
    f.text = frame.fixtures[f.id]?.text ?? '';
    f.state = frame.fixtures[f.id]?.state ?? '';
  }
  return w;
}
