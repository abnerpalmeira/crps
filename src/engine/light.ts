import { grantsOf } from './effects';
import type { Item, Pos, WorldState } from './types';

/** Cor padrão da luz de itens (lanterna, vela) e de poderes. */
export const WARM_LIGHT = '#ffd9a0';
export const POWER_LIGHT = '#fff3c4';

export interface LightSource {
  /** Id do item aceso, ou `personagem#luzN` para luz emitida por perk ou condição. */
  id: string;
  kind: 'item' | 'character';
  name: string;
  pos: Pos;
  radius: number;
  intensity: number;
  color: string;
  /** Quem carrega a luz (na mão ou no corpo); null se ela está num móvel ou no chão. */
  carrierId: string | null;
}

function itemPlace(world: WorldState, item: Item): { locationId: string; pos: Pos; carrierId: string | null } | null {
  const h = item.holder;
  if (h.kind === 'ground') return { locationId: h.locationId, pos: { x: h.x, y: h.y }, carrierId: null };
  if (h.kind === 'character') {
    const c = world.characters[h.id];
    return c?.locationId && c.pos ? { locationId: c.locationId, pos: c.pos, carrierId: c.id } : null;
  }
  for (const loc of Object.values(world.locations)) {
    const f = loc.fixtures.find((fx) => fx.id === h.id);
    if (f) return { locationId: loc.id, pos: { x: f.x + Math.floor((f.w - 1) / 2), y: f.y + Math.floor((f.h - 1) / 2) }, carrierId: null };
  }
  return null;
}

/** Luzes acesas num local: itens (lanterna, vela, tocha) e personagens que emitem luz. */
export function lightSources(world: WorldState, locationId: string): LightSource[] {
  const out: LightSource[] = [];
  for (const item of Object.values(world.items)) {
    if (!item.light?.on) continue;
    const place = itemPlace(world, item);
    if (place?.locationId !== locationId) continue;
    const { radius, intensity, color = WARM_LIGHT } = item.light;
    out.push({ id: item.id, kind: 'item', name: item.name, pos: place.pos, radius, intensity, color, carrierId: place.carrierId });
  }
  for (const c of Object.values(world.characters)) {
    if (c.locationId !== locationId || !c.pos) continue;
    grantsOf(world, c.id).forEach((g, i) => {
      if (g.kind !== 'light') return;
      out.push({ id: `${c.id}#luz${i}`, kind: 'character', name: c.name, pos: c.pos!, radius: g.radius, intensity: g.intensity, color: g.color ?? POWER_LIGHT, carrierId: c.id });
    });
  }
  return out;
}

/** Luz num tile, de 0 (breu) a 1: a ambiente do local ou a da luz mais forte que chega ali. */
export function lightAt(world: WorldState, locationId: string, pos: Pos, sources = lightSources(world, locationId)): number {
  let level = world.locations[locationId]?.light ?? 1;
  for (const s of sources) {
    const d = Math.hypot(s.pos.x - pos.x, s.pos.y - pos.y);
    if (d > s.radius) continue;
    level = Math.max(level, s.intensity * (1 - (d / (s.radius + 1)) ** 2));
  }
  return Math.round(level * 100) / 100;
}

/** Nome da luz para o mestre e para a interface. */
export function lightLabel(level: number): 'claro' | 'penumbra' | 'escuro' {
  return level >= 0.6 ? 'claro' : level >= 0.2 ? 'penumbra' : 'escuro';
}
