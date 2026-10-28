import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { compileBrief } from './engine/brief';
import { GameEngine } from './engine/engine';
import { SPEECH_LINE } from './engine/frames';
import type { GmEvent } from './gm/gm';
import { SaveStore, createGameMaster, describeError, loadEnv } from './gm/runtime';

loadEnv();
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const store = new SaveStore();
const gm = createGameMaster();
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY });
// O iterador guarda as linhas que chegam antes da pergunta (entrada por pipe).
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt: string): Promise<string | null> {
  stdout.write(prompt);
  const next = await lines.next();
  return next.done ? null : next.value.trim();
}

let streamed = '';
let pendingLine = '';
let current: GameEngine | null = null;

/** Falas `@id: texto` aparecem como "Nome: texto". */
function formatLine(line: string): string {
  const speech = SPEECH_LINE.exec(line);
  if (!speech) return line;
  const name = current?.state.characters[speech[1].toLowerCase()]?.name ?? speech[1];
  return `\x1b[1m${name}:\x1b[0m ${speech[2]}`;
}

/** A narração chega em pedaços; cada linha só é impressa inteira, já formatada. */
function writeNarration(chunk: string): void {
  pendingLine += chunk;
  for (let nl = pendingLine.indexOf('\n'); nl >= 0; nl = pendingLine.indexOf('\n')) {
    stdout.write(`${formatLine(pendingLine.slice(0, nl))}\n`);
    pendingLine = pendingLine.slice(nl + 1);
  }
}

function print(event: GmEvent): void {
  switch (event.type) {
    case 'narration_delta':
      streamed += event.text;
      writeNarration(event.text);
      break;
    case 'narration_reset':
      if (streamed) stdout.write(dim('\n↺ (o mestre reescreveu)\n'));
      streamed = '';
      pendingLine = '';
      break;
    case 'narration':
      if (event.text.trim() !== streamed.trim()) stdout.write(`\n${event.text.split('\n').map(formatLine).join('\n')}\n`);
      else stdout.write(`${formatLine(pendingLine)}\n`);
      streamed = '';
      pendingLine = '';
      break;
    case 'tool':
      stdout.write(dim(`  ${event.summary}\n`));
      break;
    case 'verify':
      if (!event.consistent) stdout.write(dim(`  🔁 verificador: ${event.issues.join(' | ')}\n`));
      break;
    case 'status':
      stdout.write(dim(`${event.text}\n`));
      break;
    case 'error':
      stdout.write(`\n⚠️  ${event.message}\n`);
      break;
    default:
      break;
  }
}

async function newGame(): Promise<GameEngine | null> {
  const premise = await ask('\nQual cenário você quer jogar?\n> ');
  if (!premise) return null;
  store.archive();
  const engine = GameEngine.create(premise);
  current = engine;
  await gm.setup(engine, print);
  store.save(engine);
  return engine;
}

async function main(): Promise<void> {
  console.log(dim(`CRPS · mestre: ${gm.label} · comandos: /estado, /novo, /sair`));
  let engine = store.load();
  current = engine;
  if (engine) {
    const last = [...engine.state.log].reverse().find((e) => e.kind === 'narration');
    console.log(dim('\nContinuando a campanha salva.'));
    if (last) console.log(`\n${last.text.split('\n').map(formatLine).join('\n')}`);
  } else {
    engine = await newGame();
  }
  while (engine) {
    const input = await ask('\n> ');
    if (input === null || input === '/sair') break;
    if (!input) continue;
    if (input === '/estado') {
      console.log(dim(compileBrief(engine)));
      continue;
    }
    try {
      if (input === '/novo') engine = (await newGame()) ?? engine;
      else {
        await gm.play(engine, input, print);
        store.save(engine);
      }
    } catch (err) {
      print({ type: 'error', message: describeError(err) });
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
