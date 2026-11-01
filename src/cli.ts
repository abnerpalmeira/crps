import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { compileBrief } from './engine/brief';
import { GameEngine } from './engine/engine';
import { parseSpeechLine } from './engine/frames';
import type { GmEvent } from './gm/gm';
import { CostMeter, describeCost, toCredits } from './gm/pricing';
import { SaveStore, createGameMaster, creditUsdFromEnv, describeError, loadEnv, loadModelCatalog } from './gm/runtime';

loadEnv();
loadModelCatalog();
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

/** As ações que o mestre sugeriu na última narração: 1, 2 ou 3 escolhe uma. */
let options: string[] = [];
let current: GameEngine | null = null;
let meter = new CostMeter();

/** A CLI é ferramenta de desenvolvimento: mostra o custo em US$ e em créditos. */
function printCost(): void {
  const cost = meter.summary();
  meter = new CostMeter();
  if (!cost.requests) return;
  const credits = toCredits(cost.usd, creditUsdFromEnv());
  stdout.write(dim(`  💲 US$ ${cost.usd.toFixed(4)} (${credits} créditos) · ${describeCost(cost)}\n`));
}

/** Falas `@id[modo>alvo]: texto` aparecem como "Nome (cochicho → Mei): texto"; as não ouvidas, só como gesto. */
function formatLine(line: string): string {
  const speech = parseSpeechLine(line);
  if (!speech) return line;
  const nameOf = (id: string) => current?.state.characters[id]?.name ?? id;
  if (speech.hidden) return dim(`${nameOf(speech.speakerId)} 🤫 ${speech.text}`);
  const to = speech.targetId ? `→ ${nameOf(speech.targetId).split(' ')[0]}` : '';
  const how = [speech.mode !== 'fala' ? speech.mode : '', to].filter(Boolean).join(' ') + (speech.via ? `, via ${speech.via}` : '');
  return `\x1b[1m${nameOf(speech.speakerId)}${how ? ` (${how})` : ''}:\x1b[0m ${speech.text}`;
}

function print(event: GmEvent): void {
  switch (event.type) {
    case 'narration':
      stdout.write(`\n${event.text.split('\n').map(formatLine).join('\n')}\n`);
      options = event.options;
      options.forEach((option, i) => stdout.write(dim(`  ${i + 1}. ${option}\n`)));
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
    case 'usage':
      meter.add(event.usage);
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
  try {
    await gm.setup(engine, print);
  } finally {
    printCost();
  }
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
    if (last) console.log(`\n${(last.playerText ?? last.text).split('\n').map(formatLine).join('\n')}`);
  } else {
    engine = await newGame();
  }
  while (engine) {
    const typed = await ask('\n> ');
    if (typed === null || typed === '/sair') break;
    const input = /^[1-3]$/.test(typed) ? (options[Number(typed) - 1] ?? typed) : typed;
    if (input !== typed) stdout.write(dim(`  ${input}\n`));
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
    } finally {
      printCost();
    }
  }
  rl.close();
}

main().catch((err) => {
  console.error(describeError(err));
  process.exit(1);
});
