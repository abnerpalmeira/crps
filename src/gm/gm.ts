import { compileBrief } from '../engine/brief';
import type { GameEngine } from '../engine/engine';
import { describeInput, hasMarks, parsePlayerInput } from '../engine/input';
import { analyzeActs } from '../engine/body';
import { performMenuAct } from '../engine/perform';
import { analyzeReading } from '../engine/reading';
import { analyzeSpeech, playerNarration, type SpeechLine } from '../engine/speech';
import { runTool, toolSpecs, type ToolResult } from '../engine/tools';
import type { WorldState } from '../engine/types';
import type { CostEvent } from './pricing';
import { SYSTEM_PROMPT, setupMessage, turnMessage, verifierFeedback, verifierPrompt } from './prompts';
import type { Effort, ModelProvider, ModelSession, Usage, Verdict } from './provider';

/** Eventos que o servidor transmite ao cliente (NDJSON) e a CLI imprime. */
export type GmEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; ok: boolean; summary: string; input: unknown; result: string }
  | { type: 'narration_delta'; text: string }
  | { type: 'narration_reset' }
  | { type: 'narration'; text: string; turn: number }
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
    await this.atomically(engine, emit, async () => {
      engine.log('system', `Premissa: ${engine.state.premise}`);
      emit({ type: 'status', text: 'Montando o mundo…' });
      emit({ type: 'state', world: engine.snapshot() });
      await this.runTurn(engine, setupMessage(engine.state.premise), this.opts.effortSetup ?? 'medium', engine.state.premise, emit, [], [], true);
    });
  }

  async play(engine: GameEngine, input: string, emit: Emit): Promise<void> {
    await this.atomically(engine, emit, async () => {
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
      await this.runTurn(engine, turnMessage(brief, input, marked), this.opts.effortTurn ?? 'low', verified, emit, changes, gestures);
    });
  }

  /** Se a API cair no meio do turno, o mundo volta ao que era antes dele. */
  private async atomically(engine: GameEngine, emit: Emit, run: () => Promise<void>): Promise<void> {
    const before = engine.toJSON();
    try {
      await run();
    } catch (err) {
      engine.state = JSON.parse(before);
      emit({ type: 'state', world: engine.snapshot() });
      throw err;
    }
  }

  /** `changes` traz o que o motor já fez antes do mestre (ações do menu); `gestures`, marcas que a narração precisa ter. */
  private async runTurn(
    engine: GameEngine,
    userMessage: string,
    effort: Effort,
    input: string,
    emit: Emit,
    done: string[] = [],
    gestures: string[] = [],
    setup = false,
  ): Promise<void> {
    const system = typeof this.opts.system === 'function' ? this.opts.system(engine.state, setup) : (this.opts.system ?? SYSTEM_PROMPT);
    const session = this.opts.provider.startSession({ system, tools: toolSpecs(), userMessage, effort });
    const changes = [...done];
    let result = await this.loop(engine, session, emit, changes);

    if (result.verifiable && result.text) {
      // Alcance das falas, dos gestos e das leituras é regra do motor: confere sem depender do verificador.
      const speechIssues = [
        ...analyzeSpeech(engine.state, result.text).issues,
        ...analyzeActs(engine.state, result.text),
        ...analyzeReading(engine.state, result.text).issues,
      ];
      const verdict = this.opts.verify !== false ? await this.check(engine, changes, input, result.text, emit) : null;
      if (verdict) emit({ type: 'verify', ...verdict });
      if (speechIssues.length) emit({ type: 'verify', consistent: false, issues: speechIssues });
      const issues = [...speechIssues, ...(verdict && !verdict.consistent ? verdict.issues : [])];
      if (issues.length) {
        emit({ type: 'narration_reset' });
        session.addUserText(verifierFeedback(issues));
        const corrected = await this.loop(engine, session, emit, changes);
        if (corrected.text) result = { ...corrected, text: dropPreamble(corrected.text) };
      }
    }

    const told = result.text || SILENCE;
    const missing = gestures.filter((g) => !told.includes(g));
    const text = missing.length ? `${missing.join(' ')}\n${told}` : told;
    const speech = analyzeSpeech(engine.state, text);
    const reading = analyzeReading(engine.state, text);
    const outside = [...speech.issues, ...analyzeActs(engine.state, text), ...reading.issues];
    if (outside.length) emit({ type: 'status', text: `Falas, gestos e leituras ainda fora das regras: ${outside.join(' ')}` });
    this.recordSpeech(engine, speech.lines);
    engine.hearVoices(speech.lines);
    // Quem leu passa a saber o texto; a primeira leitura de um texto ainda não escrito o define.
    for (const line of reading.lines) {
      const item = engine.state.items[line.itemId];
      if (typeof item.text !== 'string') engine.writeText(item, line.text, null);
      engine.readText(item, line.readerId);
    }
    const shown = playerNarration(engine.state, text);
    engine.log('narration', text, shown !== text ? shown : undefined);
    engine.recordFrame();
    emit({ type: 'narration', text: shown, turn: engine.state.turn });
    emit({ type: 'state', world: engine.snapshot() });
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
      let streamed = false;
      // Linhas de fala só saem inteiras e já como o jogador as percebe.
      const filter = new SpeechFilter(
        (line) => playerNarration(engine.state, line),
        (text) => {
          streamed = true;
          emit({ type: 'narration_delta', text });
        },
      );
      const step = await session.step({
        onText: (delta) => filter.push(delta),
        onRetry: () => {
          filter.reset();
          if (streamed) emit({ type: 'narration_reset' });
          streamed = false;
        },
      });
      filter.flush();
      if (step.usage) emit({ type: 'usage', usage: step.usage });
      if (step.stop === 'refusal') {
        if (streamed) emit({ type: 'narration_reset' });
        return { text: REFUSAL, verifiable: false };
      }
      const text = step.text.trim();
      if (step.stop !== 'tool_use') return { text: text || reserve, verifiable: step.stop === 'end_turn' };

      // Texto antes de tools não é a narração do turno; fica só de reserva.
      if (text) reserve = text;
      if (streamed) emit({ type: 'narration_reset' });
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

  private async check(engine: GameEngine, changes: string[], input: string, narration: string, emit: Emit): Promise<Verdict | null> {
    try {
      const state = compileBrief(engine, { recentTurns: 0 });
      const { verdict, usage } = await this.opts.provider.verify(verifierPrompt({ state, changes, input, narration }));
      if (usage) emit({ type: 'usage', usage });
      return verdict;
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

/**
 * Repassa a narração em pedaços, mas segura cada linha que começa com "@" (uma fala) até ela
 * fechar, para transformá-la antes: o jogador nunca recebe o conteúdo de algo que não ouviu.
 */
export class SpeechFilter {
  private line = '';
  private holding = false;
  private atLineStart = true;

  constructor(
    private readonly transform: (line: string) => string,
    private readonly out: (text: string) => void,
  ) {}

  push(chunk: string): void {
    let passthrough = '';
    for (const ch of chunk) {
      if (this.atLineStart && ch === '@') this.holding = true;
      if (this.holding) {
        if (ch === '\n') {
          // Fala que o jogador nem vê nem ouve some inteira, sem deixar linha em branco.
          const shown = this.transform(this.line);
          if (shown) passthrough += `${shown}\n`;
          this.line = '';
          this.holding = false;
          this.atLineStart = true;
        } else {
          this.line += ch;
          this.atLineStart = false;
        }
      } else {
        passthrough += ch;
        this.atLineStart = ch === '\n';
      }
    }
    if (passthrough) this.out(passthrough);
  }

  flush(): void {
    if (this.holding && this.line) this.out(this.transform(this.line));
    this.reset();
  }

  reset(): void {
    this.line = '';
    this.holding = false;
    this.atLineStart = true;
  }
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
