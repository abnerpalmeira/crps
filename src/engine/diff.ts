import type { Fact, ItemHolder, WorldState } from './types';

/**
 * O que o turno mudou no mundo, comparando o estado de antes com o de depois. A conferência cruza
 * o que a narração conta com isto: quem a narração faz andar e não andou, o item que muda de mãos
 * sem ter mudado, quem descobre um fato e continua sem saber.
 */
export interface WorldDiff {
  /** Mudou de local, de tile ou de assento. */
  moved: Set<string>;
  /** Mudou de pose ou de alvo da pose. */
  posed: Set<string>;
  /** Mudou de dono, de mão, de lugar ou de quantidade; sumiu ou surgiu. */
  items: Set<string>;
  /** Itens que não existiam antes do turno. */
  createdItems: Set<string>;
  /** Fato → quem passou a saber. */
  learned: Map<string, string[]>;
  /** Personagem → quem ele passou a conhecer. */
  met: Map<string, string[]>;
  /** Quem teve algum recurso mudado (vida…). */
  resources: Set<string>;
  /** Minutos que o relógio andou. */
  minutes: number;
  /** Itens e móveis com o texto escrito novo ou mudado. */
  written: Set<string>;
  /** "quem>por quem" dos sentimentos novos ou mudados. */
  feelings: Set<string>;
  /** Personagens criados no turno. */
  created: Set<string>;
  /** Quem teve as falas prontas trocadas. */
  lines: Set<string>;
}

export function worldDiff(before: WorldState, after: WorldState): WorldDiff {
  const diff: WorldDiff = {
    moved: new Set(),
    posed: new Set(),
    items: new Set(),
    createdItems: new Set(),
    learned: new Map(),
    met: new Map(),
    resources: new Set(),
    minutes: minutesOf(after) - minutesOf(before),
    written: new Set(),
    feelings: new Set(),
    created: new Set(),
    lines: new Set(),
  };
  for (const c of Object.values(after.characters)) {
    const b = before.characters[c.id];
    if (!b) {
      // Quem nasceu no turno foi posto no lugar, no corpo e com as falas de agora.
      for (const set of [diff.created, diff.moved, diff.posed, diff.resources, diff.lines]) set.add(c.id);
      continue;
    }
    if (b.locationId !== c.locationId || b.pos?.x !== c.pos?.x || b.pos?.y !== c.pos?.y || b.seatId !== c.seatId) diff.moved.add(c.id);
    if ((b.pose ?? null) !== (c.pose ?? null) || (b.poseTarget ?? null) !== (c.poseTarget ?? null)) diff.posed.add(c.id);
    if (Object.keys({ ...b.resources, ...c.resources }).some((k) => b.resources[k] !== c.resources[k])) diff.resources.add(c.id);
    const met = c.knows.filter((id) => !b.knows.includes(id));
    if (met.length) diff.met.set(c.id, met);
    for (const [toward, f] of Object.entries(c.feelings)) {
      const old = b.feelings[toward];
      if (!old || old.degree !== f.degree || old.text !== f.text) diff.feelings.add(`${c.id}>${toward}`);
    }
    if (JSON.stringify([b.lines?.turn, b.lines?.general]) !== JSON.stringify([c.lines?.turn, c.lines?.general])) diff.lines.add(c.id);
  }
  for (const id of new Set([...Object.keys(before.items), ...Object.keys(after.items)])) {
    const b = before.items[id];
    const a = after.items[id];
    if (!b && a) diff.createdItems.add(id);
    if (!b || !a || !sameHolder(b.holder, a.holder) || b.quantity !== a.quantity) diff.items.add(id);
    if (a && typeof a.text === 'string' && a.text !== b?.text) diff.written.add(id);
  }
  // O texto de um móvel (o quadro, uma placa) também é escrita.
  for (const loc of Object.values(after.locations)) {
    for (const fixture of loc.fixtures) {
      const old = before.locations[loc.id]?.fixtures.find((x) => x.id === fixture.id);
      if (fixture.text && fixture.text !== old?.text) diff.written.add(fixture.id);
    }
  }
  for (const f of after.facts) {
    const b = before.facts.find((x) => x.id === f.id);
    const was = b ? knowers(b, before) : [];
    const learned = knowers(f, after).filter((id) => !was.includes(id));
    if (learned.length) diff.learned.set(f.id, learned);
  }
  return diff;
}

function minutesOf(world: WorldState): number {
  return world.clock.day * 1440 + world.clock.minutes;
}

function knowers(f: Fact, world: WorldState): string[] {
  return f.knownBy === 'all' ? Object.keys(world.characters) : f.knownBy;
}

function sameHolder(a: ItemHolder, b: ItemHolder): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ground' && b.kind === 'ground') return a.locationId === b.locationId && a.x === b.x && a.y === b.y;
  if (a.kind === 'character' && b.kind === 'character') return a.id === b.id && (a.hand ?? null) === (b.hand ?? null);
  return a.kind === 'fixture' && b.kind === 'fixture' && a.id === b.id;
}
