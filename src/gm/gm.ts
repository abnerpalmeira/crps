import { compileBrief } from '../engine/brief';
import type { GameEngine } from '../engine/engine';
import { describeInput, hasMarks, parsePlayerInput } from '../engine/input';
import { analyzeActs } from '../engine/body';
import { dropRepeated } from '../engine/checks';
import { performMenuAct } from '../engine/perform';
import { analyzeReading } from '../engine/reading';
import { analyzeSpeech, playerNarration, type SpeechLine } from '../engine/speech';
import { runTool, toolSpecs, type ToolResult } from '../engine/tools';
import type { WorldState } from '../engine/types';
import { LlmChecker, type CheckInput, type Checker } from './checker';
import type { CostEvent } from './pricing';
import { OPTIONS_REQUEST, SYSTEM_PROMPT, setupMessage, turnMessage, verifierFeedback } from './prompts';
import type { Effort, ModelProvider, ModelSession, Usage, Verdict } from './provider';

/** Eventos que o servidor transmite ao cliente (NDJSON) e a CLI imprime. */
export type GmEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; ok: boolean; summary: string; input: unknown; result: string }
  /** A narração do turno, só depois de conferida, como o jogador a percebe, e as ações que o mestre sugere. */
  | { type: 'narration'; text: string; turn: number; options: string[] }
  | { type: 'state'; world: WorldState }
  | { type: 'verify'; consistent: boolean; issues: string[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'error'; message: string }
  /** Emitido pelo servidor no fim do turno: US$ no modo dev, só créditos no release. */
  | CostEvent
  | { type: 'done' };

export type Emit = (event: GmEvent) => void;

export interface GameMasterOptions {
  provider: ModelProvider;
  effortSetup?: Effort;
  effortTurn?: Effort;
  /** Roda o verificador de consistência depois de cada narração (padrão: sim). */
  verify?: boolean;
  /** Quem confere a narração (padrão: o modelo do mestre, com o verificador de sempre). */
  checker?: Checker;
  /**
   * Prompt do mestre (padrão: SYSTEM_PROMPT, sem os visuais do catálogo 3D). Como função, sai do
   * mundo: os visuais são os da época dele, e na criação (setup) a época ainda não existe.
   */
  system?: string | ((world: WorldState, setup: boolean) => string);
  maxSteps?: number;
}

const SILENCE = '(O mestre ficou em silêncio. Tente descrever sua ação de outro jeito.)';
const REFUSAL = '(O mestre não consegue narrar esse caminho. Tente descrever a ação de outra forma.)';

interface LoopResult {
  text: string;
  /** false quando o turno terminou de forma anormal (recusa, limite de tokens ou de passos). */
  verifiable: boolean;
}

export class GameMaster {
  constructor(private readonly opts: GameMasterOptions) {}

  get label(): string {
    return this.opts.provider.label;
  }

  /** Monta o mundo inicial a partir da premissa, num motor recém-criado. */
  async setup(engine: GameEngine, emit: Emit): Promise<void> {
    await this.atomically(engine, emit, async (before) => {
      engine.log('system', `Premissa: ${engine.state.premise}`);
      emit({ type: 'status', text: 'Montando o mundo…' });
      emit({ type: 'state', world: engine.snapshot() });
      await this.runTurn(engine, setupMessage(engine.state.premise), this.opts.effortSetup ?? 'medium', engine.state.premise, emit, [], [], true, before);
    });
  }

  async play(engine: GameEngine, input: string, emit: Emit): Promise<void> {
    await this.atomically(engine, emit, async (before) => {
      engine.beginTurn();
      // O que o jogador pensa neste turno vira estado: só quem percebe mentes fica sabendo.
      const segments = parsePlayerInput(input);
      const player = engine.player;
      if (player) {
        const thought = segments.filter((s) => s.kind === 'pensamento').map((s) => s.text).join(' ');
        engine.updateCharacter({ character_id: player.id, thoughts: thought });
      }
      // Ações do menu: o motor faz agora as físicas (sentar, pegar, empunhar…), com as mesmas tools;
      // o mestre recebe o resultado e resolve o resto com os ids.
      const menu = segments.filter((s) => s.kind === 'menu').map((s) => performMenuAct(engine, s.act!));
      const changes: string[] = [];
      for (const { name, input: args, result } of menu.flatMap((o) => o.tools)) {
        emit({ type: 'tool', name, ok: result.ok, summary: result.summary, input: args, result: result.content });
        if (result.ok && result.mutated) changes.push(result.summary);
      }
      if (changes.length) emit({ type: 'state', world: engine.snapshot() });
      const marked = hasMarks(segments) ? describeInput(engine.state, segments, menu.map((o) => o.line)) : [];
      const brief = compileBrief(engine);
      engine.log('player', input);
      for (const summary of changes) engine.log('tool', summary);
      const verified = marked.length ? `${input}\n\nComo o jogador marcou:\n${marked.join('\n')}` : input;
      // O gesto escolhido no menu acontece no 3D mesmo que a narração esqueça a marca.
      const gestures = menu
        .filter((o) => o.act.verb === 'gesto' && o.act.target && player)
        .map((o) => `{${player!.id}:${o.act.target}${o.act.other ? `>${o.act.other}` : ''}}`);
      await this.runTurn(engine, turnMessage(brief, input, marked), this.opts.effortTurn ?? 'low', verified, emit, changes, gestures, false, before);
    });
  }

  /** Se a API cair no meio do turno, o mundo volta ao que era antes dele. */
  private async atomically(engine: GameEngine, emit: Emit, run: (before: WorldState) => Promise<void>): Promise<void> {
    const before = engine.toJSON();
    try {
      await run(JSON.parse(before) as WorldState);
    } catch (err) {
      engine.state = JSON.parse(before);
      emit({ type: 'state', world: engine.snapshot() });
      throw err;
    }
  }

  /**
   * `changes` traz o que o motor já fez antes do mestre (ações do menu); `gestures`, marcas que a
   * narração precisa ter; `before`, o mundo antes do turno, para a conferência ver o que mudou.
   */
  private async runTurn(
    engine: GameEngine,
    userMessage: string,
    effort: Effort,
    input: string,
    emit: Emit,
    done: string[] = [],
    gestures: string[] = [],
    setup = false,
    before: WorldState = JSON.parse(engine.toJSON()) as WorldState,
  ): Promise<void> {
    const system = typeof this.opts.system === 'function' ? this.opts.system(engine.state, setup) : (this.opts.system ?? SYSTEM_PROMPT);
    const session = this.opts.provider.startSession({ system, tools: toolSpecs(), userMessage, effort });
    const changes = [...done];
    let result = await this.loop(engine, session, emit, changes);

    if (result.verifiable && result.text) {
      // Alcance das falas, dos gestos e das leituras é regra do motor: confere sem depender do verificador.
      const { narration } = splitOptions(result.text);
      const speechIssues = [
        ...analyzeSpeech(engine.state, narration).issues,
        ...analyzeActs(engine.state, narration),
        ...analyzeReading(engine.state, narration).issues,
      ];
      if (this.opts.verify !== false) emit({ type: 'status', text: 'Conferindo a narração…' });
      // O verificador vê também as ações sugeridas: elas não podem usar nome nem fato que o jogador não sabe.
      const verdict = this.opts.verify !== false ? await this.check({ engine, before, changes, input, narration: result.text }, emit) : null;
      if (verdict) emit({ type: 'verify', ...verdict });
      if (speechIssues.length) emit({ type: 'verify', consistent: false, issues: speechIssues });
      const issues = [...speechIssues, ...(verdict && !verdict.consistent ? verdict.issues : [])];
      if (issues.length) {
        emit({ type: 'status', text: 'Ajustando a narração…' });
        session.addUserText(verifierFeedback(issues));
        const corrected = await this.loop(engine, session, emit, changes);
        if (corrected.text) result = { ...corrected, text: dropPreamble(corrected.text) };
      }
    }

    const { narration, options: suggested } = splitOptions(result.text);
    // Sempre três ações: se o mestre esqueceu, ele é chamado de novo só para elas.
    const options = result.verifiable && narration && suggested.length < 3 ? await this.askOptions(session, emit, suggested) : suggested;
    const told = narration || SILENCE;
    const missing = gestures.filter((g) => !told.includes(g));
    const text = missing.length ? `${missing.join(' ')}\n${told}` : told;
    const speech = analyzeSpeech(engine.state, text);
    const reading = analyzeReading(engine.state, text);
    const outside = [...speech.issues, ...analyzeActs(engine.state, text), ...reading.issues];
    if (outside.length) emit({ type: 'status', text: `Falas, gestos e leituras ainda fora das regras: ${outside.join(' ')}` });
    // A fala pronta que repete o que a pessoa acabou de dizer na narração sai: o jogador já ouviu.
    for (const c of Object.values(engine.state.characters)) dropRepeated(c, speech.lines.filter((l) => l.speakerId === c.id).map((l) => l.text));
    this.recordSpeech(engine, speech.lines);
    engine.hearVoices(speech.lines);
    // Quem leu passa a saber o texto; a primeira leitura de um texto ainda não escrito o define.
    for (const line of reading.lines) {
      const item = engine.state.items[line.itemId];
      if (typeof item.text !== 'string') engine.writeText(item, line.text, null);
      engine.readText(item, line.readerId);
    }
    const shown = playerNarration(engine.state, text);
    engine.log('narration', text, shown !== text ? shown : undefined, options);
    engine.recordFrame();
    emit({ type: 'narration', text: shown, turn: engine.state.turn, options });
    emit({ type: 'state', world: engine.snapshot() });
  }

  /** Pede só as ações, sem refazer a narração. Se a chamada falhar, o turno fica com as que havia. */
  private async askOptions(session: ModelSession, emit: Emit, had: string[]): Promise<string[]> {
    try {
      session.addUserText(OPTIONS_REQUEST);
      const step = await session.step();
      if (step.usage) emit({ type: 'usage', usage: step.usage });
      const { options } = splitOptions(step.text);
      return options.length ? options : had;
    } catch {
      return had;
    }
  }

  /** Cochichos e falas que nem todos ouviram viram conhecimento só de quem ouviu. */
  private recordSpeech(engine: GameEngine, lines: SpeechLine[]): void {
    for (const line of lines.filter((l) => l.restricted)) {
      const speaker = engine.state.characters[line.speakerId];
      const target = line.targetId ? engine.state.characters[line.targetId] : null;
      const label = engine.state.ruleset.speech[line.mode]?.label ?? 'fala';
      engine.addFact({
        subject: line.speakerId,
        text: `${speaker.name} ${label}${target ? ` para ${target.name}` : ''}: "${line.text}"`,
        known_by: line.hearers,
      });
    }
  }

  private async loop(engine: GameEngine, session: ModelSession, emit: Emit, changes: string[]): Promise<LoopResult> {
    let reserve = '';
    for (let i = 0; i < (this.opts.maxSteps ?? 30); i++) {
      // O texto não vai ao jogador enquanto chega: a narração só sai inteira, depois de conferida.
      let writing = false;
      const step = await session.step({
        onText: () => {
          if (!writing) emit({ type: 'status', text: 'O mestre está narrando…' });
          writing = true;
        },
      });
      if (step.usage) emit({ type: 'usage', usage: step.usage });
      if (step.stop === 'refusal') return { text: REFUSAL, verifiable: false };
      const text = step.text.trim();
      if (step.stop !== 'tool_use') return { text: text || reserve, verifiable: step.stop === 'end_turn' };

      // Texto antes de tools não é a narração do turno; fica só de reserva.
      if (text) reserve = text;
      let mutated = false;
      const results = step.toolCalls.map((call) => {
        const r = safeRunTool(engine, call.name, call.input);
        emit({ type: 'tool', name: call.name, ok: r.ok, summary: r.summary, input: call.input, result: r.content });
        if (r.ok && r.mutated) {
          mutated = true;
          changes.push(r.summary);
          engine.log('tool', r.summary);
        }
        return { id: call.id, content: r.content, isError: !r.ok };
      });
      if (mutated) emit({ type: 'state', world: engine.snapshot() });
      session.addToolResults(results);
    }
    return { text: reserve, verifiable: false };
  }

  private async check(input: CheckInput, emit: Emit): Promise<Verdict | null> {
    try {
      const r = await (this.opts.checker ?? new LlmChecker(this.opts.provider)).check(input);
      for (const usage of r.usages) emit({ type: 'usage', usage });
      if (r.note) emit({ type: 'status', text: r.note });
      return r.verdict;
    } catch (err) {
      emit({ type: 'status', text: `Verificador indisponível (${err instanceof Error ? err.message : String(err)}); seguindo sem checagem.` });
      return null;
    }
  }
}

/** Recado do mestre sobre a correção ("segue a narração corrigida"), que o jogador não deve ler. */
const PREAMBLE = /narra[çc][ãa]o (corrigida|final|reescrita|completa)|segue a narra|verificador|corrigida deste turno/i;

/** Tira da narração corrigida um primeiro parágrafo que fala da correção em vez de contar a história. */
export function dropPreamble(text: string): string {
  const [first, ...rest] = text.split(/\n\s*\n/);
  return rest.length && PREAMBLE.test(first) ? rest.join('\n\n').trim() : text;
}

/** Ação sugerida: linha ">> texto" no fim da resposta do mestre (aceita ">" e numeração). */
const OPTION = /^\s*>{1,2}\s*(?:\d+[.)]\s*|[-*•]\s*)?(.+?)\s*$/;

/** Separa da narração as ações que o mestre sugere ao jogador: a narração fica sem elas, e vão até três. */
export function splitOptions(text: string): { narration: string; options: string[] } {
  const narration: string[] = [];
  const options: string[] = [];
  for (const line of text.split('\n')) {
    const option = OPTION.exec(line)?.[1];
    if (option) options.push(option);
    else narration.push(line);
  }
  return { narration: narration.join('\n').trim(), options: options.slice(0, 3) };
}

/** Um bug no motor vira erro de tool para o modelo, em vez de derrubar o turno. */
function safeRunTool(engine: GameEngine, name: string, input: unknown): ToolResult {
  try {
    return runTool(engine, name, input);
  } catch (err) {
    console.error(`[crps] erro interno em ${name}:`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `Erro interno do motor em ${name}: ${message}`, summary: `⚠️ ${name}: erro interno`, mutated: false };
  }
}
