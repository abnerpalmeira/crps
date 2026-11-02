import type { GameEngine } from '../engine/engine';
import type { FreeHooks } from '../engine/free';
import { nextLine } from '../engine/lines';
import { distanceBetween, knowsName, strangerLabel } from '../engine/perception';
import type { Character, Fact, ReadyLine } from '../engine/types';
import type { JevAnswer, JevClient } from './jev';
import type { Usage } from './provider';

/**
 * O Jev decide pelos NPCs, sempre entre opções que o motor monta: quem toma a iniciativa agora,
 * que fala pronta cabe quando o jogador puxa conversa e, no turno do mestre, como quem o jogador
 * procura reage e o que conta, entre os fatos que sabe. O mestre narra o que foi decidido.
 */
export type ReactionKind = 'coopera' | 'desconversa' | 'mente' | 'recusa' | 'se_irrita';

export interface Reaction {
  npcId: string;
  how: ReactionKind;
  /** O fato que a pessoa conta ao jogador, entre os que ela sabe e ele não; null se não conta nada novo. */
  fact: Fact | null;
}

const HOW: Record<ReactionKind, string> = {
  coopera: 'responde de boa vontade e conta o que sabe',
  desconversa: 'muda de assunto ou responde vago',
  mente: 'diz algo que sabe ser falso',
  recusa: 'se recusa a responder',
  se_irrita: 'fica irritado com o jogador',
};

/** Como o mestre lê a reação decidida, na mensagem do turno. */
export const REACTION_TEXT: Record<ReactionKind, string> = {
  coopera: 'responde de boa vontade',
  desconversa: 'muda de assunto ou responde vago',
  mente: 'mente: diz algo que sabe ser falso',
  recusa: 'se recusa a responder',
  se_irrita: 'fica irritado(a) com o jogador',
};

/**
 * Iniciativa só com 0,65 ou mais. A reação e o fato contado vão pela probabilidade da opção mais
 * provável (0,45 e 0,55), e não pela confiança do Jev, que fica baixa mesmo com a resposta clara
 * quando há poucas opções. Sem decisão, o mestre decide sozinho, como antes.
 */
const COMES = 0.65;
const DECIDED = 0.45;
const TELLS = 0.55;

/** A opção mais provável de uma escolha, se a probabilidade dela chega a `min`. */
function likeliest(answer: JevAnswer | undefined, min: number): string | null {
  if (answer?.type !== 'choice') return null;
  const [choice, p] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0] ?? [];
  return choice && p >= min ? choice : null;
}

const keyOf = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Quem decide pelos NPCs: os ganchos do grid livre e a reação no turno do mestre. */
export interface NpcDecider {
  hooks(engine: GameEngine, onUsage?: (usage: Usage) => void): FreeHooks;
  react(engine: GameEngine, input: string, npcId: string, onUsage: (usage: Usage) => void): Promise<Reaction | null>;
}

export class JevDecider implements NpcDecider {
  constructor(private readonly jev: JevClient) {}

  get available(): boolean {
    return this.jev.available;
  }

  /** Os ganchos do grid livre para este motor. `onUsage` recebe o uso de cada pedido ao Jev. */
  hooks(engine: GameEngine, onUsage: (usage: Usage) => void = () => {}): FreeHooks {
    if (!this.available) return {};
    // Com o Jev fora do ar, o grid segue as regras de sempre: a próxima fala, o mais perto.
    return {
      line: (npc) => this.line(engine, npc, onUsage).catch(() => undefined),
      initiative: (candidates, entries) => this.initiative(engine, candidates, entries, onUsage).catch(() => candidates[0] ?? null),
    };
  }

  /**
   * A fala que o NPC diz quando o jogador puxa conversa: não repete o que já disse, e não diz em voz
   * alta o que não deve ouvir quem está perto. A melhor aposta do Jev vale mais que a fila cega; se
   * a melhor aposta é "nenhuma", a conversa fica com o mestre.
   */
  async line(engine: GameEngine, npc: Character, onUsage: (usage: Usage) => void): Promise<ReadyLine | null | undefined> {
    const lines = npc.lines ? [...npc.lines.turn, ...npc.lines.general] : [];
    const me = engine.player;
    if (!lines.length || !me) return undefined;
    const world = engine.state;
    const said = npc.lines!.turn.slice(0, npc.lines!.heard).map((l) => l.text);
    const near = Object.values(world.characters)
      .filter((c) => !c.isPlayer && c.id !== npc.id && c.locationId === npc.locationId && (distanceBetween(world, npc.id, c.id) ?? Infinity) <= 3)
      .map((c) => `${c.name}${knowsName(world, me.id, c.id) ? '' : ` ("${strangerLabel(c)}" para o jogador)`}`);
    const r = await this.jev.ask(
      {
        quem_fala: { nome: npc.name, papel: npc.role, pensa: npc.thoughts ?? undefined, sente_pelo_jogador: npc.feelings[me.id]?.text },
        ja_disse_ao_jogador: said,
        acabou_de_acontecer: recentEvents(engine),
        perto_agora: near,
      },
      {
        fala: {
          type: 'choice',
          instructions: `O jogador puxou conversa com ${npc.name}. Qual destas falas ${npc.name} diz agora? Não repete o que já disse ao jogador (veja \`ja_disse_ao_jogador\` e \`acabou_de_acontecer\`) e não diz em voz alta o que não deve ser ouvido por quem está perto (veja \`perto_agora\`). Se nenhuma cabe, escolha nenhuma.`,
          criteria: { nenhuma: 'nenhuma cabe agora', ...Object.fromEntries(lines.map((l, i) => [`f${i}`, l.whisper ? `${l.text} (cochichada, só para o jogador)` : l.text])) },
        },
      },
    );
    onUsage(r.usage);
    const answer = r.answers.fala;
    if (answer?.type !== 'choice') return undefined;
    return answer.choice === 'nenhuma' ? null : (lines[Number(answer.choice.slice(1))] ?? undefined);
  }

  /**
   * Quem toma a iniciativa agora, entre os que o mestre marcou: o mestre diz quem quer falar com o
   * jogador, e o Jev diz se é a hora, pelo que acabou de acontecer. Um por vez, o mais provável.
   */
  async initiative(engine: GameEngine, candidates: Character[], entries: string[], onUsage: (usage: Usage) => void): Promise<Character | null> {
    const me = engine.player;
    if (!me) return null;
    const world = engine.state;
    const r = await this.jev.ask(
      {
        acabou_de_acontecer: entries,
        pessoas: candidates.map((c) => ({
          id: c.id,
          nome: c.name,
          papel: c.role,
          pensa: c.thoughts ?? undefined,
          quer: c.goals ?? undefined,
          sente_pelo_jogador: c.feelings[me.id]?.text,
          o_mestre_marcou: c.lines?.initiative === 'vem' ? 'vir até o jogador' : 'chamar o jogador',
          tem_a_dizer: nextLine(c)?.text,
          passos_ate_o_jogador: distanceBetween(world, me.id, c.id),
        })),
      },
      Object.fromEntries(
        candidates.map((c) => [
          `vem_${keyOf(c.id)}`,
          {
            type: 'noul' as const,
            instructions: `Agora, logo depois do que está em \`acabou_de_acontecer\`, ${c.name} (id ${c.id}) iria por iniciativa própria falar com o jogador? Veja em \`pessoas\` o que essa pessoa tem a dizer.`,
          },
        ]),
      ),
    );
    onUsage(r.usage);
    const p = (c: Character) => {
      const a = r.answers[`vem_${keyOf(c.id)}`];
      return a?.type === 'noul' ? a.noul : 0;
    };
    const best = [...candidates].sort((a, b) => p(b) - p(a))[0];
    return best && p(best) >= COMES ? best : null;
  }

  /**
   * No turno do mestre, como reage quem o jogador procura, e o que conta, entre os fatos que sabe e
   * o jogador não. O mestre narra isso; o fato contado o motor registra antes.
   */
  async react(engine: GameEngine, input: string, npcId: string, onUsage: (usage: Usage) => void): Promise<Reaction | null> {
    const world = engine.state;
    const me = engine.player;
    const npc = world.characters[npcId];
    if (!this.available || !me || !npc) return null;
    // O que a pessoa sabe e o jogador não: o que ela poderia contar (o fato sobre ela mesma, ela sabe).
    const tellable = world.facts
      .filter((f) => (engine.knows(npc.id, f) || f.subject === npc.id) && !engine.knows(me.id, f))
      .slice(-30)
      .reverse();
    const r = await this.jev.ask(
      {
        acao_do_jogador: input,
        npc: { nome: npc.name, papel: npc.role, jeito: npc.traits, pensa: npc.thoughts ?? undefined, quer: npc.goals ?? undefined, sente_pelo_jogador: npc.feelings[me.id]?.text },
        o_que_sabe: Object.fromEntries(tellable.map((f) => [keyOf(f.id), short(f.text)])),
      },
      {
        como: {
          type: 'choice',
          instructions: `Como ${npc.name} reage ao que o jogador faz em \`acao_do_jogador\`, pelo que sabe, pensa, quer e sente?`,
          criteria: HOW,
        },
        ...(tellable.length
          ? {
              conta: {
                type: 'choice' as const,
                instructions: `Na resposta ao que o jogador faz em \`acao_do_jogador\`, qual destas coisas que ${npc.name} sabe (em \`o_que_sabe\`) ele conta ao jogador?`,
                criteria: { nada: 'não conta nenhuma delas', ...Object.fromEntries(tellable.map((f) => [keyOf(f.id), short(f.text, 220)])) },
              },
            }
          : {}),
      },
    );
    onUsage(r.usage);
    const how = likeliest(r.answers.como, DECIDED) as ReactionKind | null;
    if (!how || !HOW[how]) return null;
    const pick = likeliest(r.answers.conta, TELLS);
    // Quem desconversa, mente ou recusa não conta um fato de verdade.
    const fact = pick && pick !== 'nada' && (how === 'coopera' || how === 'se_irrita') ? (tellable.find((f) => keyOf(f.id) === pick) ?? null) : null;
    return { npcId, how, fact };
  }
}

/** O que acabou de acontecer, como o jogador viu: a última narração e o que veio depois dela. */
function recentEvents(engine: GameEngine): string[] {
  const log = engine.state.log;
  const last = log.map((e) => e.kind).lastIndexOf('narration');
  return log
    .slice(Math.max(0, last))
    .filter((e) => e.kind === 'narration' || e.kind === 'free')
    .map((e) => short(e.playerText ?? e.text, 1500))
    .slice(-12);
}
