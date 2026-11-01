import { actionsFor, type ActionOption } from '../engine/actions';
import type { GameEngine } from '../engine/engine';
import type { FreeAct } from '../engine/free';
import { parsePlayerInput } from '../engine/input';
import { perceptionOf, strangerLabel } from '../engine/perception';
import type { Character, ReadyLine } from '../engine/types';
import { chosen, yesNo, type JevAnswer, type JevClient, type JevQuestion } from './jev';
import type { Usage } from './provider';

/**
 * O que o texto do jogador pede, quando o motor resolve sem o mestre: uma das ações livres que o
 * menu oferece na cena (andar, sentar, pegar, passar por uma porta conhecida…), ou uma pergunta a
 * alguém que uma fala pronta dele já responde.
 */
export type ReadPlan =
  | { kind: 'act'; act: FreeAct; label: string }
  /** `said`: as palavras do jogador, quando ele as escreveu (entre aspas ou em discurso direto). */
  | { kind: 'line'; npcId: string; line: ReadyLine; said: string | null };

export interface ReadResult {
  plan: ReadPlan | null;
  usages: Usage[];
  /** Com quem o jogador fala, quando fala com uma pessoa só e o grid não resolve: o Jev decide a reação dela. */
  addressee?: string;
}

export interface InputReader {
  read(engine: GameEngine, input: string): Promise<ReadResult>;
}

/**
 * Sim só com 0,8 ou mais; uma escolha, com confiança de 0,6; a fala pronta que responde, com 0,8,
 * porque uma resposta errada quebra a cena e o mestre só custa o turno. Na dúvida, o mestre resolve.
 */
const YES = 0.8;
const CONFIDENT = 0.6;
const ANSWERS = 0.8;
/** Texto mais longo que isto costuma pedir mais de uma coisa: fica com o mestre. */
const MAX_TEXT = 200;

const keyOf = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');

/**
 * O Jev lê o texto do jogador e escolhe entre opções que o motor monta. Tudo vai num pedido só: as
 * perguntas são independentes, e a resposta de quem fala vem junto, para cada pessoa em cena (o
 * código usa só a da pessoa com quem o jogador fala). Pensamentos, marcas do menu, sussurros
 * marcados e texto comprido ficam com o mestre, sem chamar o Jev.
 */
export class JevReader implements InputReader {
  constructor(private readonly jev: JevClient) {}

  async read(engine: GameEngine, input: string): Promise<ReadResult> {
    const none: ReadResult = { plan: null, usages: [] };
    const me = engine.player;
    const text = input.trim();
    if (!this.jev.available || !me?.pos || !me.locationId || !text || text.length > MAX_TEXT) return none;
    const segments = parsePlayerInput(text);
    if (segments.some((s) => s.kind === 'menu' || s.kind === 'pensamento' || s.kind === 'sussurro')) return none;
    const world = engine.state;
    const view = perceptionOf(world, me.id);
    const people = Object.values(world.characters).filter((c) => !c.isPlayer && c.pos && c.locationId === me.locationId && (view.recognize(c.id) || view.sight(c.id) === 'nitido'));
    const shown = (c: Character) => (view.recognize(c.id) ? c.name : strangerLabel(c));
    const acts = freeActions(engine, people, shown);
    const listeners = { ninguem: 'ninguém', varias: 'mais de uma pessoa, ou todos', ...Object.fromEntries(people.map((c) => [keyOf(c.id), shown(c)])) };
    const questions: Record<string, JevQuestion> = {
      uma: { type: 'noul', instructions: 'Em `texto_do_jogador`, o jogador faz uma coisa só? Ir até alguém para falar com essa pessoa conta como uma coisa.' },
      fala: { type: 'noul', instructions: 'Em `texto_do_jogador`, o jogador diz algo em voz alta a alguém: fala, pergunta, pede, chama ou grita?' },
      direto: { type: 'noul', instructions: '`texto_do_jogador` traz as palavras exatas que o jogador diz, em discurso direto?' },
      com_quem: { type: 'choice', instructions: 'Em `texto_do_jogador`, com quem o jogador fala?', criteria: listeners },
      acao: {
        type: 'choice',
        instructions: 'Em `texto_do_jogador`, qual destas ações físicas o jogador faz?',
        criteria: { nenhuma: 'nenhuma destas: o jogador fala, pergunta, pensa ou faz outra coisa', ...Object.fromEntries(acts.map((a, i) => [`a${i}`, a.label])) },
      },
    };
    // Especulativo: para cada pessoa com falas prontas, qual delas responde, se for com ela.
    for (const c of people) {
      const lines = linesOf(c);
      if (!lines.length) continue;
      questions[`resposta_${keyOf(c.id)}`] = {
        type: 'choice',
        instructions: `Qual destas falas de ${shown(c)} é uma resposta direta ao que o jogador diz em \`texto_do_jogador\`, que faria sentido como a fala seguinte da conversa? Ter palavras em comum não basta. Se nenhuma responde de verdade, escolha nenhuma.`,
        criteria: { nenhuma: 'nenhuma responde ao que o jogador disse', ...Object.fromEntries(lines.map((l, i) => [`f${i}`, l.text])) },
      };
    }
    const r = await this.jev.ask({ texto_do_jogador: text, pessoas_em_cena: people.map(shown) }, questions);
    const a = r.answers;
    const usages = [r.usage];
    const pick = chosen(a.acao, CONFIDENT);
    const action = pick && pick !== 'nenhuma' ? acts[Number(pick.slice(1))] : undefined;
    if (yesNo(a.fala, YES) === true) {
      // Fala: com uma pessoa, sem outra ação além de ir até ela, e com uma fala pronta que responde.
      const npc = people.find((c) => keyOf(c.id) === chosen(a.com_quem, CONFIDENT));
      const other = action && !(action.act.kind === 'walk' && 'near' in action.act && action.act.near === npc?.id);
      const line = npc ? pickLine(npc, a[`resposta_${keyOf(npc.id)}`]) : null;
      if (!npc || !line || other || (a.uma?.type === 'noul' && a.uma.noul < 0.5)) return { plan: null, usages, ...(npc ? { addressee: npc.id } : {}) };
      const quoted = segments
        .filter((s) => s.kind === 'fala')
        .map((s) => s.text)
        .join(' ');
      const said = quoted || (yesNo(a.direto, YES) === true ? text : null);
      return { plan: { kind: 'line', npcId: npc.id, line, said }, usages };
    }
    // Ação: uma só, sem fala clara, e escolhida com confiança entre as do menu.
    if (action && yesNo(a.uma, YES) === true) return { plan: { kind: 'act', act: action.act, label: action.label }, usages };
    return { plan: null, usages };
  }
}

function linesOf(c: Character): ReadyLine[] {
  return c.lines ? [...c.lines.turn, ...c.lines.general] : [];
}

function pickLine(c: Character, answer: JevAnswer | undefined): ReadyLine | null {
  const pick = chosen(answer, ANSWERS);
  return pick && pick !== 'nenhuma' ? (linesOf(c)[Number(pick.slice(1))] ?? null) : null;
}

/**
 * As ações livres que o menu oferece na cena, para o próprio jogador, as pessoas, os móveis e os
 * itens à mão: cada uma com o rótulo do menu, o alvo e a distância, como o jogador as veria.
 */
export function freeActions(engine: GameEngine, people: Character[], shown: (c: Character) => string): { label: string; act: FreeAct }[] {
  const world = engine.state;
  const me = engine.player!;
  const loc = world.locations[me.locationId!];
  const out: { label: string; act: FreeAct }[] = [];
  const add = (options: ActionOption[], what: string) => {
    for (const o of options) {
      if (o.options) add(o.options, what);
      if (!o.free || o.disabled || o.free.kind === 'talk') continue;
      let label = o.label;
      // A postura do menu é ali mesmo, sem móvel ("sentado" é no chão); a porta diz aonde leva.
      if (o.free.kind === 'act' && o.free.verb === 'pose') label = `Mudar a postura ali mesmo, sem móvel: ${o.label}`;
      if (o.free.kind === 'act' && o.free.verb === 'passar' && o.free.target) {
        const to = (loc.exits?.[o.free.target]?.to ?? []).map((id) => world.locations[id]?.name).filter(Boolean);
        if (to.length) label = `${o.label}, que leva a ${to.join(' ou ')}`;
      }
      out.push({ label: `${label}${what ? ` — ${what}` : ''}${o.note ? ` (${o.note})` : ''}`, act: o.free });
    }
  };
  add(actionsFor(world, { kind: 'character', id: me.id }), '');
  for (const c of people) add(actionsFor(world, { kind: 'character', id: c.id }), shown(c));
  // O id distingue móveis de mesmo nome: "mesa (mesa-1)", como o mestre os chama.
  for (const f of loc.fixtures) add(actionsFor(world, { kind: 'fixture', id: f.id }), `${f.label} (${f.id.slice(loc.id.length + 1)})`);
  const items = Object.values(world.items).filter((i) => {
    const h = i.holder;
    return (h.kind === 'character' && h.id === me.id) || (h.kind === 'ground' && h.locationId === loc.id) || (h.kind === 'fixture' && h.id.startsWith(`${loc.id}/`));
  });
  for (const i of items) add(actionsFor(world, { kind: 'item', id: i.id }), i.name);
  return out.slice(0, 200);
}
