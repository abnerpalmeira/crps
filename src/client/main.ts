import { parseSpeechLine } from '../engine/frames';
import type { FreeAct } from '../engine/free';
import { openQuestion } from '../engine/lines';
import { NARRATE_INPUT } from '../engine/text';
import type { WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';
import { chooseModel, fetchState, freeAction, streamEvents } from './api';
import { Playback } from './playback';
import { WorldView } from './scene';
import './style.css';
import { Ui, type TurnView } from './ui';

const ui = new Ui();
const view = new WorldView(document.querySelector<HTMLElement>('#stage-canvas')!);
// Quem fala, ou o item que está sendo lido (a leitura vira legenda com o nome do papel).
const playback = new Playback(view, ui, (id) => world?.characters[id]?.name ?? (world?.items[id] ? `📜 ${world.items[id].name}` : null));
let world: WorldState | null = null;
let busy = false;

view.onPick = (pick) => ui.showInspector(world, pick);
ui.onSelect = (pick) => view.select(pick);
ui.onReplay = (turn) => playback.playTurn(turn);
ui.onControl = (command) => {
  if (command === 'live') playback.live();
  if (command === 'toggle') playback.toggle();
  if (command === 'next') playback.next();
  if (command === 'prev') playback.prev();
  if (command === 'nextFrame') playback.nextFrame();
  if (command === 'prevFrame') playback.prevFrame();
};

// ← → passam as falas, espaço toca/pausa, Esc volta ao vivo (fora dos campos de texto).
document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement || document.querySelector('dialog[open]')) return;
  const command = { ArrowRight: 'next', ArrowLeft: 'prev', ' ': 'toggle', Escape: 'live' }[e.key];
  if (!command) return;
  e.preventDefault();
  ui.onControl(command);
});

function applyWorld(next: WorldState): void {
  world = next;
  playback.setWorld(next);
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
    case 'narration':
      turn.final(event.text);
      turn.setTurn(event.turn);
      ui.showTalk(null);
      ui.setOptions(event.options);
      break;
    case 'verify':
      if (!event.consistent) turn.note('🔁 O verificador pediu uma correção ao mestre');
      break;
    case 'free':
      turn.free(event.entries);
      turn.note('⚡ Resolvido no grid, sem o mestre');
      ui.showTalk(event.conversation ?? null);
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
    case 'cost':
      turn.cost(event);
      ui.addCost(event);
      break;
    case 'done':
      break;
  }
}

async function run(path: '/api/new' | '/api/turn', body: Record<string, unknown>, input: string | null): Promise<void> {
  busy = true;
  ui.setBusy(true);
  playback.live();
  const turn = ui.beginTurn(input);
  turn.setStatus(path === '/api/new' ? 'Montando o mundo…' : 'O mestre está pensando…');
  let failure: string | null = null;
  // Marcados dentro do callback: a análise de fluxo do TypeScript não vê, daí o "as".
  let freed = null as string[] | null;
  let narrated = false as boolean;
  try {
    await streamEvents(path, body, (event) => {
      if (event.type === 'error') failure = event.message;
      if (event.type === 'free') freed = event.entries;
      if (event.type === 'narration') narrated = true;
      handle(event, turn);
    });
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    turn.error(failure);
  } finally {
    turn.finish();
    busy = false;
    ui.setBusy(false);
  }
  // A pergunta que alguém fez na narração abre a conversa, com as respostas prontas.
  if (narrated && world) ui.showTalk(openQuestion(world));
  // Resolvido no grid: sem turno novo para rever, só o balão de quem respondeu.
  if (failure === null && freed && !narrated) {
    if (freed.some((e) => parseSpeechLine(e))) playback.showLast();
  } else if (failure === null) playback.playLatest();
  else if (path === '/api/new') await resync(failure);
}

/** Depois de uma criação que falhou, volta a mostrar a campanha que o servidor manteve (ou nenhuma). */
async function resync(failure: string): Promise<void> {
  const state = await fetchState().catch(() => null);
  if (!state) return;
  if (state.world) {
    applyWorld(state.world);
    ui.renderHistory(state.world);
    ui.notice(`Não deu para criar a campanha nova: ${failure} A campanha anterior continua salva.`);
  } else {
    world = null;
    view.clear();
    ui.renderNoWorld();
  }
}

ui.onSend = (text, to) => {
  if (!busy && world) void run('/api/turn', to ? { input: text, to } : { input: text }, text);
};

// Sem escrever nada: o mestre narra o que acontece agora, e o turno seguinte traz um tempo novo.
ui.onNarrate = () => {
  if (!busy && world) void run('/api/turn', { narrate: true }, NARRATE_INPUT);
};

/** Andar e conversar com as falas prontas: o motor faz na hora, sem o mestre. */
async function runFree(act: FreeAct): Promise<void> {
  if (busy || !world) return;
  busy = true;
  playback.live();
  // Andar dentro dos passos do turno é só do motor: o personagem sai na hora, e o servidor confirma.
  view.predict(act);
  try {
    const r = await freeAction(act);
    applyWorld(r.world);
    ui.addFree(r.entries);
    // Quem falou com o jogador abre a conversa: respostas prontas, continuar, dizer outra coisa ou encerrar.
    ui.showTalk(r.conversation ?? null);
    if (!r.ok && r.error) ui.notice(r.error);
    if (r.note) ui.notice(r.note);
    // A fala ouvida (de quem o jogador procurou, ou de quem veio até ele) aparece no balão sobre quem falou.
    if (r.entries.some((e) => parseSpeechLine(e))) playback.showLast();
  } catch (err) {
    ui.notice(err instanceof Error ? err.message : String(err));
  } finally {
    busy = false;
  }
}
ui.onFree = (act) => void runFree(act);
view.onWalk = (x, y) => void runFree({ kind: 'walk', x, y });
let modelNames = new Map<string, string>();
const modelName = (id: string) => modelNames.get(id) ?? id;

ui.onModel = (id) => {
  if (busy) return;
  chooseModel(id)
    .then((model) => {
      ui.setModel(model);
      ui.notice(`O mestre agora é o ${modelName(model)}. Vale a partir do próximo turno.`);
    })
    .catch((err: Error) => ui.notice(err.message));
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
    ui.setMode(state.mode);
    ui.setModel(state.model, state.models);
    modelNames = new Map(state.models.map((m) => [m.id, m.name]));
    if (state.world) {
      applyWorld(state.world);
      ui.renderHistory(state.world);
      ui.showTalk(openQuestion(state.world));
    } else ui.openNewGame(true);
    if (state.busy) ui.notice('O mestre ainda está terminando um turno anterior. Recarregue a página em instantes.');
  } catch {
    ui.notice('Não consegui falar com o servidor. Ele está rodando? Use `npm run dev`.');
  }
})();
