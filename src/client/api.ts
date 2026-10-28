import type { WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';

export interface StateResponse {
  world: WorldState | null;
  busy: boolean;
  model: string;
}

export async function fetchState(): Promise<StateResponse> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`O servidor respondeu ${res.status}.`);
  return (await res.json()) as StateResponse;
}

/** POST que devolve NDJSON: um evento do mestre por linha, conforme acontecem. */
export async function streamEvents(path: '/api/new' | '/api/turn', body: Record<string, string>, onEvent: (event: GmEvent) => void): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok || !res.body) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `O servidor respondeu ${res.status}.`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as GmEvent);
    }
  }
}
