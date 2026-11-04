import { compileBrief } from '../engine/brief';
import type { GameEngine } from '../engine/engine';
import { describeInput, hasMarks, parsePlayerInput } from '../engine/input';
import { analyzeActs } from '../engine/body';
import { dropRepeated } from '../engine/checks';
import { answer, freeAct, TALK_REACH, type FreeAct, type FreeOutcome } from '../engine/free';
import type { Conversation } from '../engine/lines';
import { distanceBetween } from '../engine/perception';
import { performMenuAct } from '../engine/perform';
import { analyzeReading } from '../engine/reading';
import { analyzeSpeech, playerNarration, type SpeechLine } from '../engine/speech';
import { NARRATE_INPUT } from '../engine/text';
import { runTool, toolSpecs, type ToolResult } from '../engine/tools';
import type { WorldState } from '../engine/types';
import { LlmChecker, type CheckInput, type Checker } from './checker';
import { REACTION_TEXT, type NpcDecider, type Reaction } from './decider';
import type { CostEvent } from './pricing';
import { OPTIONS_REQUEST, SYSTEM_PROMPT, setupMessage, turnMessage, verifierFeedback } from './prompts';
import type { Effort, ModelProvider, ModelSession, Usage, Verdict } from './provider';
import type { InputReader } from './reader';
import { WRITER_PROMPT, WriterSchema, writerMessage, writingCalls, writtenText, type Writing } from './writer';

/** Eventos que o servidor transmite ao cliente (NDJSON) e a CLI imprime. */
export type GmEvent =
  | { type: 'status'; text: string }
  | { type: 'tool'; name: string; ok: boolean; summary: string; input: unknown; result: string }
  /** A narração do turno, só depois de conferida, como o jogador a percebe, e as ações que o mestre sugere. */
  | { type: 'narration'; text: string; turn: number; options: string[] }
  | { type: 'state'; world: WorldState }
  | { type: 'verify'; consistent: boolean; issues: string[] }
  /** O texto do jogador resolvido no grid, sem o mestre: os passos e as falas, como o jogador os vê, e a conversa aberta. */
  | { type: 'free'; entries: string[]; conversation?: Conversation }
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
  /** Quem lê o texto do jogador antes do turno, para resolver no grid o que não precisa do mestre. */
  reader?: InputReader;
  /** Quem decide pelos NPCs: a fala que cabe, quem toma a iniciativa e, no turno, como reage quem o jogador procura. */
  decider?: NpcDecider;
  /**
   * Com a reação decidida, o turno em que o jogador só conversa vai ao escritor: uma chamada sem
   * tools, se o provedor tiver (padrão: sim).
   */
  write?: boolean;
  /**
   * Prompt do mestre (padrão: SYSTEM_PROMPT, sem os visuais do catálogo 3D). Como função, sai do
   * mundo: os visuais são os da época dele, e na criação (setup) a época ainda não existe.
   */
  system?: string | ((world: WorldState, setup: boolean) => string);
  maxSteps?: number;
}

const SILENCE = '(O mestre ficou em silêncio. Tente descrever sua ação de outro jeito.)';
const REFUSAL = '(O mestre não consegue narrar esse caminho. Tente descrever a ação de outra forma.)';
/** Como o jogador mandou o turno: pedindo a narração sem escrever, ou falando com quem está na conversa com ele. */
export interface PlayOptions {
  narrate?: boolean;
  /** O NPC da conversa aberta: o leitor não precisa adivinhar com quem o jogador fala. */
  to?: string;
}

const TURN_TIME_MISSING = 'O turno não diz quanto tempo o jogador tem para agir no grid até a próxima narração: chame set_turn_time pelo que a cena pede.';

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

  /** Ação livre pedida pelo grid (o clique no chão, "Conversar"), com quem decide pelos NPCs. */
  async free(engine: GameEngine, act: FreeAct): Promise<FreeOutcome & { usages: Usage[] }> {
    const usages: Usage[] = [];
    const hooks = this.opts.decider?.hooks(engine, (usage) => usages.push(usage)) ?? {};
    return { ...(await freeAct(engine, act, hooks)), usages };
  }

  async play(engine: GameEngine, input: string, emit: Emit, opts: PlayOptions = {}): Promise<void> {
    // Pedir a narração não tem o que ler: o mestre conta o que acontece agora.
    if (opts.narrate) input = NARRATE_INPUT;
    const read = this.opts.reader && !opts.narrate ? await this.tryFree(engine, input, emit, opts.to) : { done: false, addressee: null, talk: false };
    if (read.done) return;
    // Quem o jogador procura: o Jev decide como reage e o que conta, e o mestre (ou o escritor) narra isso.
    const reaction = read.addressee && this.opts.decider ? await this.react(engine, input, read.addressee, emit) : null;
    await this.atomically(engine, emit, async (before) => {
      engine.beginTurn();
      const decided = reaction ? this.applyReaction(engine, reaction) : [];
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
      // Só conversa, com a reação decidida: o escritor escreve o turno, com o jogador perto de quem procura.
      const writing = reaction && read.talk && !menu.length && this.opts.write !== false && this.opts.provider.write ? this.approach(engine, reaction.npcId, emit, changes, decided) : false;
      if (changes.length) emit({ type: 'state', world: engine.snapshot() });
      const marked = hasMarks(segments) ? describeInput(engine.state, segments, menu.map((o) => o.line)) : [];
      const brief = compileBrief(engine);
      engine.log('player', input);
      // O turno mandado pelo painel de uma pessoa entra no chat dela, além do chat do mestre.
      if (opts.to) engine.state.log.at(-1)!.to = opts.to;
      for (const summary of changes) engine.log('tool', summary);
      const verified = marked.length ? `${input}\n\nComo o jogador marcou:\n${marked.join('\n')}` : input;
      // O gesto escolhido no menu acontece no 3D mesmo que a narração esqueça a marca.
      const gestures = menu
        .filter((o) => o.act.verb === 'gesto' && o.act.target && player)
        .map((o) => `{${player!.id}:${o.act.target}${o.act.other ? `>${o.act.other}` : ''}}`);
      if (writing && (await this.writeTurn(engine, (fix) => writerMessage(brief, input, marked, decided, fix), verified, emit, changes, before))) return;
      await this.runTurn(engine, turnMessage(brief, input, marked, decided), this.opts.effortTurn ?? 'low', verified, emit, changes, gestures, false, before);
    });
  }

  /**
   * O texto que o motor resolve sozinho não chama o mestre nem gasta um turno: andar, sentar, pegar,
   * passar por uma porta conhecida, ou perguntar a alguém algo que uma fala pronta dele já responde.
   * O leitor (o Jev) escolhe entre as opções do motor; na dúvida, ou se o motor recusar, segue o turno.
   */
  private async tryFree(engine: GameEngine, input: string, emit: Emit, to?: string): Promise<{ done: boolean; addressee: string | null; talk: boolean }> {
    emit({ type: 'status', text: 'Lendo o que você escreveu…' });
    try {
      const { plan, usages, addressee, talk } = await this.opts.reader!.read(engine, input, to);
      for (const usage of usages) emit({ type: 'usage', usage });
      if (!plan) return { done: false, addressee: addressee ?? null, talk: talk === true };
      const hooks = this.opts.decider?.hooks(engine, (usage) => emit({ type: 'usage', usage })) ?? {};
      const outcome = plan.kind === 'act' ? await freeAct(engine, plan.act, hooks) : await answer(engine, plan.npcId, plan.line, plan.said, hooks);
      // O que o motor fez antes de recusar (ir até lá) aconteceu e fica, e o mestre continua dali.
      if (outcome.entries.length) {
        emit({ type: 'free', entries: outcome.entries, ...(outcome.ok && outcome.conversation ? { conversation: outcome.conversation } : {}) });
        emit({ type: 'state', world: engine.snapshot() });
      }
      return { done: outcome.ok, addressee: null, talk: false };
    } catch (err) {
      emit({ type: 'status', text: `Não deu para resolver sem o mestre (${err instanceof Error ? err.message : String(err)}).` });
      return { done: false, addressee: null, talk: false };
    }
  }

  /** A decisão do Jev para quem o jogador procura; se ele falhar, o mestre decide sozinho. */
  private async react(engine: GameEngine, input: string, npcId: string, emit: Emit): Promise<Reaction | null> {
    try {
      return await this.opts.decider!.react(engine, input, npcId, (usage) => emit({ type: 'usage', usage }));
    } catch (err) {
      emit({ type: 'status', text: `Sem a decisão do Jev para quem você procura (${err instanceof Error ? err.message : String(err)}); o mestre decide.` });
      return null;
    }
  }

  /** Registra o fato que a pessoa conta e devolve a decisão como o mestre a lê na mensagem do turno. */
  private applyReaction(engine: GameEngine, r: Reaction): string[] {
    const npc = engine.state.characters[r.npcId];
    const me = engine.player;
    if (!npc || !me) return [];
    if (r.fact) engine.shareKnowledge({ fact_id: r.fact.id, to: [me.id], from: npc.id, how: 'contou na conversa' });
    const tells = r.fact ? ` e conta ao jogador ${r.fact.id} («${r.fact.text.slice(0, 200)}»)` : r.how === 'coopera' ? ', sem contar nada que o jogador ainda não saiba' : '';
    return [`${npc.name} ${REACTION_TEXT[r.how]}${tells}.`];
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
      const issues = await this.review(engine, before, changes, input, result.text, emit);
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
    this.closeTurn(engine, narration, options, gestures, emit);
  }

  /**
   * O turno de conversa pelo escritor: uma chamada sem tools devolve a narração e o que a conversa
   * mudou, e o motor aplica pelas mesmas tools. A conferência é a do mestre, com uma reescrita que
   * substitui a primeira resposta inteira. Sem resposta válida, devolve false, e o mestre narra.
   */
  private async writeTurn(
    engine: GameEngine,
    message: (fix?: { previous: Writing; issues: string[] }) => string,
    input: string,
    emit: Emit,
    done: string[],
    before: WorldState,
  ): Promise<boolean> {
    const base = engine.toJSON();
    const first = await this.write(message(), emit);
    if (!first) {
      emit({ type: 'status', text: 'Sem a resposta do escritor; o mestre narra o turno.' });
      return false;
    }
    const applied = this.applyWriting(engine, first, emit, done);
    let text = writtenText(first);
    const issues = [...applied.refused, ...(await this.review(engine, before, applied.changes, input, text, emit))];
    if (issues.length) {
      emit({ type: 'status', text: 'Ajustando a narração…' });
      const fixed = await this.write(message({ previous: first, issues }), emit);
      if (fixed) {
        // A reescrita vale no lugar da primeira: o mundo volta ao que era e recebe só ela.
        engine.state = JSON.parse(base);
        this.applyWriting(engine, fixed, emit, done);
        text = writtenText(fixed);
      }
    }
    const { narration, options } = splitOptions(text);
    this.closeTurn(engine, dropPreamble(narration), options, [], emit);
    return true;
  }

  /** Uma chamada ao escritor; resposta fora do esquema, sem narração, recusa ou erro viram null. */
  private async write(prompt: string, emit: Emit): Promise<Writing | null> {
    emit({ type: 'status', text: 'O mestre está narrando…' });
    try {
      const r = await this.opts.provider.write!({ system: WRITER_PROMPT, prompt, schema: WriterSchema, name: 'turno', effort: this.opts.effortTurn ?? 'low' });
      if (r.usage) emit({ type: 'usage', usage: r.usage });
      const out = r.data as Writing | null;
      if (out?.narracao.trim()) return out;
      emit({ type: 'status', text: 'O escritor respondeu fora do formato.' });
    } catch (err) {
      emit({ type: 'status', text: `O escritor falhou (${err instanceof Error ? err.message : String(err)}).` });
    }
    return null;
  }

  /** Aplica o que o escritor mudou pelas tools, como no loop do mestre; as recusas voltam como o que corrigir. */
  private applyWriting(engine: GameEngine, out: Writing, emit: Emit, done: string[]): { changes: string[]; refused: string[] } {
    const changes = [...done];
    const refused: string[] = [];
    for (const call of writingCalls(out, engine.state.playerId)) {
      const r = safeRunTool(engine, call.name, call.input);
      emit({ type: 'tool', name: call.name, ok: r.ok, summary: r.summary, input: call.input, result: r.content });
      if (!r.ok) refused.push(`Em ${call.field}, o motor recusou: ${r.content.slice(0, 300)}`);
      else if (r.mutated) {
        changes.push(r.summary);
        engine.log('tool', r.summary);
      }
    }
    emit({ type: 'state', world: engine.snapshot() });
    return { changes, refused };
  }

  /**
   * Antes do escritor, que não move ninguém: longe demais para conversar, o motor leva o jogador até
   * a pessoa, como o mestre faria com move_character, e o decidido conta isso a quem narra. false se
   * não houver como chegar.
   */
  private approach(engine: GameEngine, npcId: string, emit: Emit, changes: string[], decided: string[]): boolean {
    const me = engine.player;
    const npc = engine.state.characters[npcId];
    if (!me || !npc) return false;
    if ((distanceBetween(engine.state, me.id, npcId) ?? Infinity) <= TALK_REACH) return true;
    const input = { character_id: me.id, to: { near: npcId } };
    const r = safeRunTool(engine, 'move_character', input);
    emit({ type: 'tool', name: 'move_character', ok: r.ok, summary: r.summary, input, result: r.content });
    if (!r.ok) return false;
    changes.push(r.summary);
    decided.push(`O personagem do jogador vai até ${npc.name} para falar; o motor já o levou.`);
    return true;
  }

  /**
   * Confere a narração e devolve o que corrigir: o alcance das falas, dos gestos e das leituras é
   * regra do motor; o resto, a conferência. O texto vai com as ações sugeridas, que também não podem
   * usar nome nem fato que o jogador não sabe.
   */
  private async review(engine: GameEngine, before: WorldState, changes: string[], input: string, text: string, emit: Emit): Promise<string[]> {
    const { narration } = splitOptions(text);
    const speechIssues = [
      ...analyzeSpeech(engine.state, narration).issues,
      ...analyzeActs(engine.state, narration),
      ...analyzeReading(engine.state, narration).issues,
      // O tempo do turno é do mestre, a cada narração: sem ele, o jogador não sabe quanto pode agir no grid.
      ...(engine.turnTimeGiven() ? [] : [TURN_TIME_MISSING]),
    ];
    if (this.opts.verify !== false) emit({ type: 'status', text: 'Conferindo a narração…' });
    const verdict = this.opts.verify !== false ? await this.check({ engine, before, changes, input, narration: text }, emit) : null;
    if (verdict) emit({ type: 'verify', ...verdict });
    if (speechIssues.length) emit({ type: 'verify', consistent: false, issues: speechIssues });
    return [...speechIssues, ...(verdict && !verdict.consistent ? verdict.issues : [])];
  }

  /**
   * Fecha o turno: a narração vira estado (quem ouviu cada fala, o que foi lido; as falas prontas que
   * ela já disse saem) e vai ao jogador como ele a percebe. `gestures` são marcas que ela precisa ter.
   */
  private closeTurn(engine: GameEngine, narration: string, options: string[], gestures: string[], emit: Emit): void {
    const told = narration || SILENCE;
    const missing = gestures.filter((g) => !told.includes(g));
    const text = missing.length ? `${missing.join(' ')}\n${told}` : told;
    const speech = analyzeSpeech(engine.state, text);
    const reading = analyzeReading(engine.state, text);
    const outside = [...speech.issues, ...analyzeActs(engine.state, text), ...reading.issues];
    if (outside.length) emit({ type: 'status', text: `Falas, gestos e leituras ainda fora das regras: ${outside.join(' ')}` });
    // A fala pronta que repete o que a pessoa acabou de dizer na narração sai: o jogador já ouviu. Se
    // ela perguntava algo a ele, as respostas prontas ficam esperando a escolha dele.
    const playerId = engine.state.playerId;
    for (const c of Object.values(engine.state.characters)) {
      const said = speech.lines.filter((l) => l.speakerId === c.id);
      const asked = dropRepeated(c, said.map((l) => l.text)).findLast((l) => l.replies?.length);
      if (asked && playerId && said.some((l) => l.hearers.includes(playerId))) c.lines!.awaiting = asked.replies;
    }
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
    // Começa o turno do jogador: o tempo que o mestre deu (set_turn_time) para ele viver o grid sem narração.
    engine.startTurnClock();
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
