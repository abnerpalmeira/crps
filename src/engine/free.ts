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
 * um tile ou até alguém, puxar conversa com um NPC (que responde com a próxima fala pronta, de
 * set_lines) e as ações físicas do menu (sentar, pegar, acender, passar por uma porta conhecida…).
 * Depois de cada uma, um NPC com iniciativa pode vir até o jogador. Tudo entra no log como "free",
 * e o próximo turno do mestre recebe no resumo.
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

/** Até essa distância dá para conversar sem chegar mais perto. */
const TALK_REACH = 2;

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

export function freeAct(engine: GameEngine, act: FreeAct): FreeOutcome {
  const me = engine.player;
  if (!me?.pos || !me.locationId) return { ok: false, error: 'Seu personagem não está em cena.', entries: [] };
  const entries: string[] = [];
  const record = recorder(engine, entries);
  const outcome = perform(engine, me, act, record);
  // Quem tem iniciativa não espera o jogador puxar conversa: vem até ele, ou chama de onde está.
  if (outcome.ok) initiative(engine, me, record, act.kind === 'talk' ? act.with : null);
  return { ...outcome, entries };
}

/**
 * Resposta a algo que o jogador escreveu para um NPC: o jogador chega perto se precisar, diz o que
 * escreveu (quando escreveu as palavras dele) e o NPC responde com a fala pronta escolhida.
 */
export function answer(engine: GameEngine, npcId: string, line: ReadyLine, said: string | null): FreeOutcome {
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
  initiative(engine, me, record, npc.id);
  return { ok: true, entries };
}

function perform(engine: GameEngine, me: Character, act: FreeAct, record: Recorder): { ok: boolean; error?: string } {
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
  speak(engine, npc, me, record);
  return { ok: true };
}

/**
 * O NPC diz ao jogador uma fala pronta: a próxima, ou a escolhida para responder a ele. Quem ouve
 * aprende o que ela revela: o fato que ela conta e o nome de quem se apresenta. Quem não ouviu
 * (longe, surdo) fica sem saber. Só a próxima fala faz a conversa andar.
 */
function speak(engine: GameEngine, npc: Character, me: Character, record: Recorder, mode = '', said: ReadyLine = nextLine(npc)!): void {
  const line = `@${npc.id}[${said.whisper ? 'cochicho' : mode}>${me.id}]: ${said.text}`;
  const heard = analyzeSpeech(engine.state, line).lines;
  engine.hearVoices(heard);
  const hearers = [...new Set(heard.flatMap((l) => l.hearers))].filter((id) => id !== npc.id);
  if (said.fact && hearers.length) engine.shareKnowledge({ fact_id: said.fact, to: hearers, from: npc.id });
  if (said.introduces && hearers.length) engine.introduce({ who: hearers, knows: [npc.id], mutual: false });
  if (said === nextLine(npc)) npc.lines!.heard++;
  record(line);
}

/**
 * Um NPC por ação: o mais perto dos que têm iniciativa e fala do turno que o jogador ainda não ouviu.
 * Quem acabou de falar com o jogador não emenda outra fala sozinho.
 */
function initiative(engine: GameEngine, me: Character, record: Recorder, except: string | null): void {
  const distance = (c: Character) => distanceBetween(engine.state, me.id, c.id) ?? Infinity;
  const npc = engine
    .charactersIn(me.locationId!)
    .filter((c) => !c.isPlayer && c.id !== except && c.pos && c.lines?.initiative && hasNews(c))
    .sort((a, b) => distance(a) - distance(b))[0];
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
