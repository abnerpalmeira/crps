import type { FreeAct, FreeOutcome } from '../engine/free';
import type { WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';

export interface StateResponse {
  world: WorldState | null;
  busy: boolean;
  /** dev: custo em US$ e bastidores; release: só créditos. */
  mode: 'dev' | 'release';
  model: string;
  /** Modelos que podem ser o mestre (vazio no release e na demo offline). */
  models: ModelOption[];
}

export interface ModelOption {
  id: string;
  name: string;
  note: string;
  /** US$ por milhão de tokens de entrada e de saída. */
  price: { input: number; output: number } | null;
}

/** Troca o modelo do mestre; devolve o id que ficou valendo. */
export async function chooseModel(id: string): Promise<string> {
  const res = await fetch('/api/model', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }) });
  const body = (await res.json().catch(() => ({}))) as { model?: string; error?: string };
  if (!res.ok || !body.model) throw new Error(body.error ?? `O servidor respondeu ${res.status}.`);
  return body.model;
}

/** Ação livre no grid (andar, conversar): o motor resolve na hora, sem o mestre. */
export async function freeAction(act: FreeAct): Promise<FreeOutcome & { world: WorldState }> {
  const res = await fetch('/api/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(act) });
  const body = (await res.json().catch(() => ({}))) as Partial<FreeOutcome & { world: WorldState }>;
  if (!res.ok || !body.world) throw new Error(body.error ?? `O servidor respondeu ${res.status}.`);
  return body as FreeOutcome & { world: WorldState };
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
