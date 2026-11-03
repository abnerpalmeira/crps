import { z } from 'zod';
import { VERBS } from './actions';
import { gripOf } from './body';
import type { GameEngine } from './engine';
import { hasNews, nextLine } from './lines';
import { distanceBetween } from './perception';
import { performMenuAct } from './perform';
import { analyzeSpeech, playerNarration } from './speech';
import { runTool } from './tools';
import type { Character, Pos, ReadyLine } from './types';

/**
 * Ações livres no grid: o motor resolve na hora, sem o mestre e sem gastar um turno dele. Andar até
 * um tile ou até alguém, puxar conversa com um NPC (que responde com uma fala pronta, de set_lines)
 * e as ações físicas do menu (sentar, pegar, acender, passar por uma porta conhecida…). Depois de
 * cada uma, um NPC com iniciativa pode vir até o jogador. Tudo entra no log como "free", e o
 * próximo turno do mestre recebe no resumo.
 */
export const freeActSchema = z.union([
  z.object({ kind: z.literal('walk'), x: z.number().int(), y: z.number().int() }),
  z.object({ kind: z.literal('walk'), near: z.string() }),
  z.object({ kind: z.literal('talk'), with: z.string() }),
  z.object({ kind: z.literal('act'), verb: z.string(), target: z.string().nullable(), other: z.string().nullable() }),
]);

export type FreeAct = z.infer<typeof freeActSchema>;

export interface FreeOutcome {
  ok: boolean;
  /** Por que o motor recusou. */
  error?: string;
  /** O que entrou no log, como o jogador vê: passos, ações e as falas que ele ouviu. */
  entries: string[];
}

/**
 * Decisões que o motor pede a quem julga (o Jev, no mestre): o motor monta as opções, e o gancho
 * escolhe. Sem ganchos, as regras de sempre: a próxima fala da fila, e o mais perto com iniciativa.
 */
export interface FreeHooks {
  /** A fala pronta que o NPC diz agora: uma das dele, null se nenhuma cabe, undefined para a próxima da fila. */
  line?(npc: Character): Promise<ReadyLine | null | undefined>;
  /** Quem toma a iniciativa agora, entre os candidatos (null: ninguém). `entries` é o que acabou de acontecer. */
  initiative?(candidates: Character[], entries: string[]): Promise<Character | null>;
}

/** Até essa distância dá para conversar sem chegar mais perto. */
export const TALK_REACH = 2;

type Recorder = (text: string) => void;

/** Cada passo, ação e fala vai para o log como ação livre e para a lista, como o jogador percebe. */
function recorder(engine: GameEngine, entries: string[]): Recorder {
  return (text) => {
    const shown = playerNarration(engine.state, text);
    engine.log('free', text, shown !== text ? shown : undefined);
    entries.push(shown);
  };
}

/** Move alguém pelas regras de move_character; devolve a recusa do motor, se houver. */
function walk(engine: GameEngine, who: string, to: Pos | { near: string }, record: Recorder): string | null {
  const r = runTool(engine, 'move_character', { character_id: who, to });
  if (!r.ok) return r.content;
  record(r.summary);
  return null;
}

export async function freeAct(engine: GameEngine, act: FreeAct, hooks: FreeHooks = {}): Promise<FreeOutcome> {
  const me = engine.player;
  if (!me?.pos || !me.locationId) return { ok: false, error: 'Seu personagem não está em cena.', entries: [] };
  const entries: string[] = [];
  const record = recorder(engine, entries);
  const outcome = await perform(engine, me, act, record, hooks);
  // Quem tem iniciativa não espera o jogador puxar conversa: vem até ele, ou chama de onde está.
  if (outcome.ok) await initiative(engine, me, record, act.kind === 'talk' ? act.with : null, entries, hooks);
  return { ...outcome, entries };
}

/**
 * Resposta a algo que o jogador escreveu para um NPC: o jogador chega perto se precisar, diz o que
 * escreveu (quando escreveu as palavras dele) e o NPC responde com a fala pronta escolhida.
 */
export async function answer(engine: GameEngine, npcId: string, line: ReadyLine, said: string | null, hooks: FreeHooks = {}): Promise<FreeOutcome> {
  const me = engine.player;
  if (!me?.pos || !me.locationId) return { ok: false, error: 'Seu personagem não está em cena.', entries: [] };
  const npc = engine.state.characters[npcId];
  if (!npc || npc.isPlayer || npc.locationId !== me.locationId || !npc.pos) return { ok: false, error: 'Essa pessoa não está aqui.', entries: [] };
  const entries: string[] = [];
  const record = recorder(engine, entries);
  if ((distanceBetween(engine.state, me.id, npc.id) ?? Infinity) > TALK_REACH) {
    const error = walk(engine, me.id, { near: npc.id }, record);
    if (error) return { ok: false, error, entries };
  }
  if (said) {
    const mine = `@${me.id}[>${npc.id}]: ${said}`;
    engine.hearVoices(analyzeSpeech(engine.state, mine).lines);
    record(mine);
  }
  speak(engine, npc, me, record, '', line);
  await initiative(engine, me, record, npc.id, entries, hooks);
  return { ok: true, entries };
}

async function perform(engine: GameEngine, me: Character, act: FreeAct, record: Recorder, hooks: FreeHooks): Promise<{ ok: boolean; error?: string }> {
  if (act.kind === 'walk') {
    // Clique no chão: num tile em que não dá para ficar (parede, móvel, alguém), vai para o livre mais perto.
    const tile = 'near' in act ? null : (engine.walkTarget(me.locationId!, { x: act.x, y: act.y }, me.id) ?? { x: act.x, y: act.y });
    if (tile && tile.x === me.pos!.x && tile.y === me.pos!.y) return { ok: true };
    const error = walk(engine, me.id, tile ?? { near: (act as { near: string }).near }, record);
    return error ? { ok: false, error } : { ok: true };
  }

  if (act.kind === 'act') {
    const item = act.target ? engine.state.items[act.target] : undefined;
    // Sacar uma arma é provocação: fica com o mestre, como mirar e atacar.
    if (!VERBS[act.verb]?.free || (act.verb === 'empunhar' && item && gripOf(item) !== 'objeto')) {
      return { ok: false, error: 'Essa ação passa pelo mestre: escreva e envie.' };
    }
    const outcome = performMenuAct(engine, { verb: act.verb, target: act.target, other: act.other });
    // O que o motor fez antes de recusar (ir até lá) aconteceu e fica.
    for (const t of outcome.tools) if (t.result.ok && t.result.mutated) record(t.result.summary);
    if (outcome.status === 'feito') return { ok: true };
    return { ok: false, error: outcome.reason ?? 'Essa ação passa pelo mestre: escreva e envie.' };
  }

  const npc = engine.state.characters[act.with];
  if (!npc || npc.isPlayer || npc.locationId !== me.locationId || !npc.pos) return { ok: false, error: 'Essa pessoa não está aqui.' };
  if (!nextLine(npc)) return { ok: false, error: 'Não há nada pronto para essa pessoa dizer agora: fale pela caixa de texto, e o mestre responde.' };
  if ((distanceBetween(engine.state, me.id, npc.id) ?? Infinity) > TALK_REACH) {
    const error = walk(engine, me.id, { near: npc.id }, record);
    if (error) return { ok: false, error };
  }
  // Quem julga escolhe a fala que cabe agora; nenhuma cabendo, a conversa fica com o mestre.
  const said = hooks.line ? await hooks.line(npc) : undefined;
  if (said === null) return { ok: false, error: `${npc.name.split(' ')[0]} não tem nada a dizer agora que caiba: fale pela caixa de texto, e o mestre responde.` };
  speak(engine, npc, me, record, '', said ?? nextLine(npc)!);
  return { ok: true };
}

/**
 * O NPC diz ao jogador uma fala pronta: a próxima, ou a escolhida para a hora. Quem ouve aprende o
 * que ela revela: o fato que ela conta e o nome de quem se apresenta. Quem não ouviu (longe, surdo)
 * fica sem saber. Uma fala do turno dita fora da ordem vai para o lugar da próxima, para a conta das
 * já ditas continuar valendo (as do turno antes de `heard` são as que o jogador ouviu).
 */
function speak(engine: GameEngine, npc: Character, me: Character, record: Recorder, mode = '', said: ReadyLine = nextLine(npc)!): void {
  const line = `@${npc.id}[${said.whisper ? 'cochicho' : mode}>${me.id}]: ${said.text}`;
  const heard = analyzeSpeech(engine.state, line).lines;
  engine.hearVoices(heard);
  const hearers = [...new Set(heard.flatMap((l) => l.hearers))].filter((id) => id !== npc.id);
  if (said.fact && hearers.length) engine.shareKnowledge({ fact_id: said.fact, to: hearers, from: npc.id });
  if (said.introduces && hearers.length) engine.introduce({ who: hearers, knows: [npc.id], mutual: false });
  const lines = npc.lines!;
  const at = lines.turn.indexOf(said);
  if (at >= lines.heard) {
    [lines.turn[at], lines.turn[lines.heard]] = [lines.turn[lines.heard], lines.turn[at]];
    lines.heard++;
  } else if (at < 0 && said === nextLine(npc)) lines.heard++;
  record(line);
}

/**
 * Um NPC por ação, entre os que o mestre marcou com iniciativa e têm fala do turno que o jogador
 * ainda não ouviu. Quem julga escolhe (ou ninguém, se não for a hora); sem quem julgue, o mais
 * perto. Quem acabou de falar com o jogador não emenda outra fala sozinho.
 */
async function initiative(engine: GameEngine, me: Character, record: Recorder, except: string | null, entries: string[], hooks: FreeHooks): Promise<void> {
  const distance = (c: Character) => distanceBetween(engine.state, me.id, c.id) ?? Infinity;
  const candidates = engine
    .charactersIn(me.locationId!)
    .filter((c) => !c.isPlayer && c.id !== except && c.pos && c.lines?.initiative && hasNews(c))
    .sort((a, b) => distance(a) - distance(b));
  if (!candidates.length) return;
  const npc = hooks.initiative ? await hooks.initiative(candidates, [...entries]) : candidates[0];
  if (!npc) return;
  // Segredo não se grita: quem vai cochichar chega perto, mesmo que só fosse chamar.
  if ((npc.lines!.initiative === 'vem' || nextLine(npc)!.whisper) && distance(npc) > TALK_REACH) {
    const r = runTool(engine, 'move_character', { character_id: npc.id, to: { near: me.id } });
    if (r.ok) record(r.summary);
  }
  // De longe, quem chama levanta a voz para alcançar o jogador.
  const far = analyzeSpeech(engine.state, `@${npc.id}[>${me.id}]: …`).issues.length > 0;
  speak(engine, npc, me, record, far ? 'grito' : '');
}
