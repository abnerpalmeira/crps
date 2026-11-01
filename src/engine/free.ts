import { z } from 'zod';
import { VERBS } from './actions';
import { gripOf } from './body';
import type { GameEngine } from './engine';
import { hasNews, nextLine } from './lines';
import { distanceBetween } from './perception';
import { performMenuAct } from './perform';
import { analyzeSpeech, playerNarration } from './speech';
import { runTool } from './tools';
import type { Character } from './types';

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

export function freeAct(engine: GameEngine, act: FreeAct): FreeOutcome {
  const me = engine.player;
  if (!me?.pos || !me.locationId) return { ok: false, error: 'Seu personagem não está em cena.', entries: [] };
  const entries: string[] = [];
  const record = (text: string) => {
    const shown = playerNarration(engine.state, text);
    engine.log('free', text, shown !== text ? shown : undefined);
    entries.push(shown);
  };
  const outcome = perform(engine, me, act, record);
  // Quem tem iniciativa não espera o jogador puxar conversa: vem até ele, ou chama de onde está.
  if (outcome.ok) initiative(engine, me, record);
  return { ...outcome, entries };
}

function perform(engine: GameEngine, me: Character, act: FreeAct, record: (text: string) => void): { ok: boolean; error?: string } {
  /** Move alguém pelas regras de move_character; devolve a recusa do motor, se houver. */
  const walk = (to: { x: number; y: number } | { near: string }): string | null => {
    const r = runTool(engine, 'move_character', { character_id: me.id, to });
    if (!r.ok) return r.content;
    record(r.summary);
    return null;
  };

  if (act.kind === 'walk') {
    // Clique no chão: num tile em que não dá para ficar (parede, móvel, alguém), vai para o livre mais perto.
    const tile = 'near' in act ? null : (engine.walkTarget(me.locationId!, { x: act.x, y: act.y }, me.id) ?? { x: act.x, y: act.y });
    if (tile && tile.x === me.pos!.x && tile.y === me.pos!.y) return { ok: true };
    const error = walk(tile ?? { near: (act as { near: string }).near });
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
    const error = walk({ near: npc.id });
    if (error) return { ok: false, error };
  }
  speak(engine, npc, me, record);
  return { ok: true };
}

/**
 * O NPC diz ao jogador a próxima fala pronta. Quem ouve aprende o que ela revela: o fato que ela
 * conta e o nome de quem se apresenta. Quem não ouviu (longe, surdo) fica sem saber.
 */
function speak(engine: GameEngine, npc: Character, me: Character, record: (text: string) => void, mode = ''): void {
  const said = nextLine(npc)!;
  const line = `@${npc.id}[${said.whisper ? 'cochicho' : mode}>${me.id}]: ${said.text}`;
  const heard = analyzeSpeech(engine.state, line).lines;
  engine.hearVoices(heard);
  const hearers = [...new Set(heard.flatMap((l) => l.hearers))].filter((id) => id !== npc.id);
  if (said.fact && hearers.length) engine.shareKnowledge({ fact_id: said.fact, to: hearers, from: npc.id });
  if (said.introduces && hearers.length) engine.introduce({ who: hearers, knows: [npc.id], mutual: false });
  npc.lines!.heard++;
  record(line);
}

/** Um NPC por ação: o mais perto dos que têm iniciativa e fala do turno que o jogador ainda não ouviu. */
function initiative(engine: GameEngine, me: Character, record: (text: string) => void): void {
  const distance = (c: Character) => distanceBetween(engine.state, me.id, c.id) ?? Infinity;
  const npc = engine
    .charactersIn(me.locationId!)
    .filter((c) => !c.isPlayer && c.pos && c.lines?.initiative && hasNews(c))
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
