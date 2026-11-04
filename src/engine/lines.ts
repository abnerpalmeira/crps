import { parseSpeechLine } from './frames';
import type { Character, ReadyLine, WorldState } from './types';

/** A conversa aberta no grid, para a interface oferecer as respostas prontas, continuar ou dizer outra coisa. */
export interface Conversation {
  with: string;
  replies: string[];
  more: boolean;
}

/** A próxima fala pronta: as do turno na ordem, depois as gerais em rodízio; sem gerais, repete a última. */
export function nextLine(c: Character): ReadyLine | null {
  const { turn = [], general = [], heard = 0 } = c.lines ?? {};
  if (heard < turn.length) return turn[heard];
  if (general.length) return general[(heard - turn.length) % general.length];
  return turn.at(-1) ?? null;
}

/** O NPC tem fala do turno que o jogador ainda não ouviu: o 3D mostra 💬 sobre ele. */
export function hasNews(c: Character): boolean {
  return Boolean(c.lines && c.lines.heard < c.lines.turn.length);
}

/** A conversa com o NPC: as respostas prontas à última fala dele e se há outra fala para ouvir. */
export function conversationWith(c: Character): Conversation {
  return { with: c.id, replies: (c.lines?.awaiting ?? []).map((r) => r.label), more: hasNews(c) || Boolean(c.lines?.general.length) };
}

/** Uma linha do chat de um personagem: uma fala do grid, o que o jogador mandou pelo painel dele ou a narração que respondeu. */
export interface ConversationEntry {
  kind: 'free' | 'player' | 'narration';
  turn: number;
  text: string;
}

/**
 * O chat do jogador com uma pessoa: as falas do grid entre os dois (as prontas, as respostas, a de
 * quem veio puxar conversa) e os turnos que o jogador mandou pelo painel dela, com a narração que
 * os respondeu. O texto é o que o jogador percebe.
 */
export function conversationLog(world: WorldState, npcId: string): ConversationEntry[] {
  const me = world.playerId;
  if (!me) return [];
  const pair = new Set([me, npcId]);
  const asked = new Set(world.log.filter((e) => e.kind === 'player' && e.to === npcId).map((e) => e.turn));
  return world.log.flatMap((e): ConversationEntry[] => {
    const text = e.playerText ?? e.text;
    if (e.kind === 'free') {
      const s = parseSpeechLine(text);
      const between = s && s.targetId && s.speakerId !== s.targetId && pair.has(s.speakerId) && pair.has(s.targetId);
      return between ? [{ kind: 'free', turn: e.turn, text }] : [];
    }
    return (e.kind === 'player' || e.kind === 'narration') && asked.has(e.turn) ? [{ kind: e.kind, turn: e.turn, text }] : [];
  });
}

/** A pergunta que um NPC perto do jogador fez e que espera a resposta dele, como a da narração. */
export function openQuestion(world: WorldState): Conversation | null {
  const me = world.playerId ? world.characters[world.playerId] : undefined;
  const npc = me && Object.values(world.characters).find((c) => !c.isPlayer && c.locationId === me.locationId && c.lines?.awaiting?.length);
  return npc ? conversationWith(npc) : null;
}
