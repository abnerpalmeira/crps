import type { WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';
import { fetchState, streamEvents } from './api';
import { WorldView } from './scene';
import './style.css';
import { Ui, type TurnView } from './ui';

const ui = new Ui();
const view = new WorldView(document.querySelector<HTMLElement>('#stage-canvas')!);
let world: WorldState | null = null;
let busy = false;

view.onPick = (pick) => ui.showInspector(world, pick);
ui.onSelect = (pick) => view.select(pick);

function applyWorld(next: WorldState): void {
  world = next;
  view.setWorld(next);
  ui.renderWorld(next);
}

function handle(event: GmEvent, turn: TurnView): void {
  switch (event.type) {
    case 'state':
      applyWorld(event.world);
      break;
    case 'tool':
      turn.tool(event);
      break;
    case 'narration_delta':
      turn.delta(event.text);
      break;
    case 'narration_reset':
      turn.reset();
      break;
    case 'narration':
      turn.final(event.text);
      break;
    case 'verify':
      if (!event.consistent) turn.note('🔁 O verificador pediu uma correção ao mestre');
      break;
    case 'status':
      turn.setStatus(event.text);
      break;
    case 'error':
      turn.error(event.message);
      break;
    case 'usage':
      ui.addUsage(event.usage);
      break;
    case 'done':
      break;
  }
}

async function run(path: '/api/new' | '/api/turn', body: Record<string, string>, input: string | null): Promise<void> {
  busy = true;
  ui.setBusy(true);
  const turn = ui.beginTurn(input);
  turn.setStatus(path === '/api/new' ? 'Montando o mundo…' : 'O mestre está pensando…');
  try {
    await streamEvents(path, body, (event) => handle(event, turn));
  } catch (err) {
    turn.error(err instanceof Error ? err.message : String(err));
  } finally {
    turn.finish();
    busy = false;
    ui.setBusy(false);
  }
}

ui.onSend = (text) => {
  if (!busy && world) void run('/api/turn', { input: text }, text);
};
ui.onNewGame = (premise) => {
  if (busy) return;
  ui.clearLog();
  view.select(null);
  void run('/api/new', { premise }, null);
};

/** No `npm run dev` o Vite sobe antes do servidor da API; tenta por alguns segundos. */
async function fetchStateWithRetry(): Promise<Awaited<ReturnType<typeof fetchState>>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchState();
    } catch (err) {
      if (attempt >= 15) throw err;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

void (async () => {
  try {
    const state = await fetchStateWithRetry();
    ui.setModel(state.model);
    if (state.world) {
      applyWorld(state.world);
      ui.renderHistory(state.world);
    } else ui.openNewGame(true);
    if (state.busy) ui.notice('O mestre ainda está terminando um turno anterior. Recarregue a página em instantes.');
  } catch {
    ui.notice('Não consegui falar com o servidor. Ele está rodando? Use `npm run dev`.');
  }
})();
