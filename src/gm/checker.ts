import { GESTURES, POSES, bodyPose, gripOf, parseActs } from '../engine/body';
import { compileBrief } from '../engine/brief';
import { hasWord, nameLeaks, nameParts } from '../engine/checks';
import { worldDiff } from '../engine/diff';
import type { GameEngine } from '../engine/engine';
import { parsePlayerInput } from '../engine/input';
import { knowsName, lifeStatId, perceptionOf, strangerLabel } from '../engine/perception';
import type { Character, Fact, Item, WorldState } from '../engine/types';
import { chosen, yesNo, type JevAnswer, type JevClient, type JevQuestion } from './jev';
import { usageCost } from './pricing';
import { verifierPrompt } from './prompts';
import type { ModelProvider, Usage, Verdict } from './provider';

/**
 * Quem confere a narração depois de cada turno. O veredito é o mesmo de sempre (consistente, e os
 * problemas em frases curtas), que o mestre recebe para corrigir.
 */
export interface CheckInput {
  engine: GameEngine;
  /** O mundo antes do turno; o do motor já tem o que o mestre mudou. */
  before: WorldState;
  /** Resumos do que as tools mudaram. */
  changes: string[];
  /** A ação do jogador (com "Como o jogador marcou", se ele usou marcas). */
  input: string;
  /** A narração crua: falas @id, marcas de gesto e, no fim, as ações sugeridas. */
  narration: string;
}

export interface CheckResult {
  verdict: Verdict | null;
  usages: Usage[];
  /** Aviso para o status: o Jev caiu e o modelo conferiu, por exemplo. */
  note?: string;
}

export interface Checker {
  check(input: CheckInput): Promise<CheckResult>;
}

/** O verificador de antes: um modelo de texto lê o estado, as mudanças e a narração. */
export class LlmChecker implements Checker {
  constructor(private readonly provider: ModelProvider) {}

  async check({ engine, changes, input, narration }: CheckInput): Promise<CheckResult> {
    const state = compileBrief(engine, { recentTurns: 0 });
    const { verdict, usage } = await this.provider.verify(verifierPrompt({ state, changes, input, narration }));
    return { verdict, usages: usage ? [usage] : [] };
  }
}

/**
 * Conferência sem modelo de texto: o código confere o que é exato (nomes, o que o estado mudou), e
 * o Jev responde perguntas atômicas sobre a narração, uma por pessoa, item ou fala. Cada resposta é
 * cruzada com o que o turno mudou, e só vira problema com confiança alta. Sem a chave, ou com o Jev
 * fora do ar, quem julga é o modelo de reserva; as checagens do código valem sempre.
 */
export class JevChecker implements Checker {
  constructor(
    private readonly jev: JevClient,
    private readonly fallback?: Checker,
  ) {}

  async check(input: CheckInput): Promise<CheckResult> {
    const plan = planCheck(input);
    if (!this.jev.available && this.fallback) return withCode(plan.code, await this.fallback.check(input));
    try {
      const results = await Promise.all(plan.requests.filter((r) => Object.keys(r.questions).length).map((r) => this.jev.ask(r.state, r.questions)));
      const answers = Object.assign({}, ...results.map((r) => r.answers)) as Record<string, JevAnswer>;
      return { verdict: verdictOf([...plan.code, ...plan.judge(answers)]), usages: results.map((r) => r.usage) };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!this.fallback) return { verdict: verdictOf(plan.code), usages: [], note: `Jev indisponível (${why}); só as checagens do código.` };
      return { ...withCode(plan.code, await this.fallback.check(input)), note: `Jev indisponível (${why}); o modelo conferiu.` };
    }
  }
}

function withCode(code: string[], r: CheckResult): CheckResult {
  if (!code.length) return r;
  return { ...r, verdict: verdictOf([...new Set([...code, ...(r.verdict?.issues ?? [])])]) };
}

export interface CheckSummary {
  verdict: Verdict | null;
  usd: number | null;
  ms: number;
  error?: string;
  note?: string;
}

export interface ShadowEntry {
  at: string;
  turn: number;
  input: string;
  narration: string;
  primary: CheckSummary;
  shadow: CheckSummary;
}

/** Roda dois verificadores ao mesmo tempo: o jogo segue o primeiro, e os dois vereditos vão para o registro. */
export class ShadowChecker implements Checker {
  constructor(
    private readonly primary: Checker,
    private readonly shadow: Checker,
    private readonly record: (entry: ShadowEntry) => void,
  ) {}

  async check(input: CheckInput): Promise<CheckResult> {
    const started = Date.now();
    const timed = async (checker: Checker) => ({ ...(await checker.check(input)), ms: Date.now() - started });
    const [primary, shadow] = await Promise.allSettled([timed(this.primary), timed(this.shadow)]);
    try {
      this.record({ at: new Date().toISOString(), turn: input.engine.state.turn, input: input.input, narration: input.narration, primary: summarize(primary), shadow: summarize(shadow) });
    } catch (err) {
      console.warn('[crps] não deu para gravar a conferência em paralelo:', err);
    }
    if (primary.status === 'rejected') throw primary.reason;
    return { ...primary.value, usages: [...primary.value.usages, ...(shadow.status === 'fulfilled' ? shadow.value.usages : [])] };
  }
}

function summarize(r: PromiseSettledResult<CheckResult & { ms: number }>): CheckSummary {
  if (r.status === 'rejected') return { verdict: null, usd: null, ms: 0, error: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  const costs = r.value.usages.map(usageCost);
  const usd = costs.some((c) => c === null) ? null : costs.reduce<number>((sum, c) => sum + (c ?? 0), 0);
  return { verdict: r.value.verdict, usd, ms: r.value.ms, ...(r.value.note ? { note: r.value.note } : {}) };
}

function verdictOf(issues: string[]): Verdict {
  return { consistent: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------------------------
// As perguntas do Jev

/** Sim só com 0,8 ou mais; escolha só com confiança de 0,5; um fato, com 0,6 de chance somada. Na dúvida, a narração passa. */
const YES = 0.8;
const CONFIDENT = 0.5;
const LIKELY = 0.6;

/** Só as posturas que a regra cobra: levantar, sentar, deitar, ajoelhar e cair. */
const POSTURE_CRITERIA = {
  nao_diz: 'a narração não diz com todas as letras que o corpo muda',
  de_pe: 'levanta-se e fica de pé',
  sentado: 'senta-se',
  deitado: 'deita-se',
  ajoelhado: 'ajoelha-se',
  caido: 'cai no chão',
};
/** As poses de pé (mãos na cintura, encostado…) contam como de pé. */
const posture = (pose: string) => (['sentado', 'deitado', 'caido', 'ajoelhado', 'agachado'].includes(pose) ? pose : 'de_pe');
// O gesto de ataque diz que é contra alguém: um tapa na mesa não é um golpe.
const GESTURE_CRITERIA = { nenhum: 'nenhum destes gestos', ...Object.fromEntries(Object.entries(GESTURES).map(([id, g]) => [id, g.attack ? `${g.label}, atacando alguém` : g.label])) };
const TREAT_CRITERIA = { nao_trata: 'não interage com o jogador', bem: 'com simpatia, ajuda ou confiança', mal: 'com hostilidade, desprezo ou medo', neutro: 'de forma neutra' };
const WEAPON_CRITERIA = { nada: 'nada acontece com ela', sacada: 'é sacada ou empunhada', guardada: 'é guardada ou largada', ataque: 'é usada para atacar' };
const TEST_CRITERIA = { nao_diz: 'a narração não diz como termina', sucesso: 'dá certo', fracasso: 'dá errado' };

type Answers = Record<string, JevAnswer>;

interface Probe {
  key: string;
  question: JevQuestion;
  judge(answer: JevAnswer | undefined, answers: Answers): string | null;
}

export interface CheckPlan {
  /**
   * Os pedidos ao Jev: um só com a narração, outro com a ação do jogador para o que depende dela, e
   * outro com as falas prontas novas. Separados, o Jev não toma o que o jogador escreveu pelo que a
   * narração conta, nem lê uma fala pronta pelo que a narração acabou de dizer.
   */
  requests: { state: Record<string, unknown>; questions: Record<string, JevQuestion> }[];
  /** Problemas que o código achou sozinho. */
  code: string[];
  /** As respostas do Jev, cruzadas com o que o turno mudou, viram problemas. */
  judge(answers: Answers): string[];
}

const keyOf = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_');
const short = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

/** Como a pergunta chama a pessoa: o nome, o id das falas e, se for o caso, como o jogador a vê. */
function who(world: WorldState, c: Character): string {
  if (c.isPlayer) return `o jogador (${c.name}, id ${c.id}; a narração o chama de "você")`;
  return `${c.name} (id ${c.id}${knowsName(world, world.playerId, c.id) ? '' : `; para o jogador é "${strangerLabel(c)}"`})`;
}

/** A narração fala da pessoa: pelas falas e marcas dela, pelo nome, por como o jogador a vê ou pelo papel. */
function mentioned(c: Character, text: string): boolean {
  if (c.isPlayer) return true;
  const lower = text.toLowerCase();
  if ([`@${c.id}`, `{${c.id}:`, `>${c.id}]`, `>${c.id}}`].some((tag) => lower.includes(tag))) return true;
  if (nameParts(c).some((p) => hasWord(text, p))) return true;
  const seen = fold((c.seenAs ?? '').replace(/^\s*(o|a|os|as|um|uma)\s+/i, '').trim());
  const folded = fold(text);
  return (seen.length >= 4 && folded.includes(seen)) || (c.role.length >= 4 && folded.includes(fold(c.role)));
}

/** O item está na cena: no chão ou num móvel do lugar, ou com alguém que está ou estava nele. */
function inScene(item: Item, here: string, world: WorldState, before: WorldState): boolean {
  const h = item.holder;
  if (h.kind === 'ground') return h.locationId === here;
  if (h.kind === 'fixture') return h.id.startsWith(`${here}/`);
  return world.characters[h.id]?.locationId === here || before.characters[h.id]?.locationId === here;
}

/** A narração cita o item por alguma palavra do nome dele. */
function itemMentioned(item: Item, text: string): boolean {
  const folded = fold(text);
  return fold(item.name)
    .split(/[^\p{L}\p{N}]+/u)
    .some((w) => w.length >= 4 && folded.includes(w));
}

function holderText(world: WorldState, item: Item): string {
  const h = item.holder;
  if (h.kind === 'ground') return 'no chão';
  if (h.kind === 'fixture') return 'num móvel';
  const c = world.characters[h.id];
  return c ? `com ${c.name}${h.hand ? ', na mão' : ''}` : 'com alguém';
}

/**
 * Monta a conferência de um turno: as checagens de código, os pedidos ao Jev e como cada resposta
 * vira problema. Só pergunta de quem a narração fala, para não encher o pedido.
 */
export function planCheck({ engine, before, changes, input, narration }: CheckInput): CheckPlan {
  const world = engine.state;
  const player = world.playerId ? world.characters[world.playerId] : null;
  const diff = worldDiff(before, world);
  const lines = narration.split('\n');
  const story = lines.filter((l) => !/^\s*>/.test(l)).join('\n');
  const options = lines.filter((l) => /^\s*>/.test(l)).map((l) => l.replace(/^\s*>{1,2}\s*/, ''));
  const action = input.split('\n\nComo o jogador marcou:')[0];
  const here = player?.locationId ?? null;
  const present = here ? Object.values(world.characters).filter((c) => c.locationId === here || before.characters[c.id]?.locationId === here) : [];
  const npcs = present.filter((c) => !c.isPlayer);
  const named = present.filter((c) => mentioned(c, story));
  const view = player ? perceptionOf(world, player.id) : null;
  const life = lifeStatId(world);
  const code: string[] = [];
  const probes: Probe[] = [];
  const actionProbes: Probe[] = [];
  const lineProbes: Probe[] = [];
  const ask = (key: string, question: JevQuestion, judge: Probe['judge'] = () => null) => probes.push({ key: keyOf(key), question, judge });
  const askAction = (key: string, question: JevQuestion, judge: Probe['judge'] = () => null) => actionProbes.push({ key: keyOf(key), question, judge });
  const askLine = (key: string, question: JevQuestion, judge: Probe['judge'] = () => null) => lineProbes.push({ key: keyOf(key), question, judge });
  const noul = (instructions: string): JevQuestion => ({ type: 'noul', instructions });
  const yes = (a?: JevAnswer) => yesNo(a, YES) === true;
  const no = (a?: JevAnswer) => yesNo(a, YES) === false;
  const pick = (a?: JevAnswer) => chosen(a, CONFIDENT);

  /**
   * Os fatos mais novos, todos, como opção: a fala sobre o atum que a pessoa sabe por um fato não
   * pode cair noutro, parecido, que ela não sabe, só por ele ser o único da lista.
   */
  const facts = world.facts.slice(-30).reverse();
  const factCriteria = (list: Fact[]) => ({ nenhum: 'nenhum destes fatos', ...Object.fromEntries(list.map((f) => [keyOf(f.id), short(f.text, 220)])) });
  /** Quem sabe o fato, ou é o assunto dele: o que o fato conta sobre a pessoa, ela mesma fez. */
  const knowsIt = (c: Character, f: Fact) => engine.knows(c.id, f) || f.subject === c.id;
  /**
   * O fato desta lista que a resposta aponta: a primeira escolha tem de ser dele, e a chance somada
   * da lista, de 0,6 ou mais. Fatos parecidos (o arame visto, o arame mostrado) dividem a escolha;
   * somados, ainda dizem que a fala é sobre eles.
   */
  const topOf = (a: JevAnswer | undefined, list: Fact[]): Fact | null => {
    if (a?.type !== 'choice') return null;
    const top = list.find((f) => keyOf(f.id) === a.choice);
    const mass = list.reduce((sum, f) => sum + (a.probabilities[keyOf(f.id)] ?? 0), 0);
    return top && mass >= LIKELY ? top : null;
  };

  // Código: nomes de quem o jogador não conhece, na narração e nas ações sugeridas.
  for (const { who: c, name } of nameLeaks(world, narration)) {
    code.push(`A narração chama pelo nome ${name} quem o jogador não conhece (para ele é "${strangerLabel(c)}"); use como ele vê a pessoa, ou registre com introduce que ele a conheceu.`);
  }

  for (const c of named) {
    const ref = who(world, c);
    ask(`move_${c.id}`, noul(`Na narração em \`narracao\`, ${ref} muda de lugar: vai até alguém ou algo, recua, se afasta, troca de lugar ou sai?`), (a) =>
      yes(a) && !diff.moved.has(c.id) ? `${c.name} muda de lugar na narração, mas a posição no estado não mudou (falta move_character).` : null,
    );
    ask(
      `pose_${c.id}`,
      { type: 'choice', instructions: `A narração em \`narracao\` diz com todas as letras que ${ref} se levanta, senta, deita, se ajoelha ou cai? Como o corpo fica no fim?`, criteria: POSTURE_CRITERIA },
      (a) => {
        const told = pick(a);
        const now = posture(bodyPose(world, c));
        return told && told !== 'nao_diz' && told !== now
          ? `Na narração ${c.name} fica ${POSES[told]?.label ?? told}, mas no estado está ${POSES[now]?.label ?? 'de pé'} (falta update_character ou move_character).`
          : null;
      },
    );
    ask(`gesto_${c.id}`, { type: 'choice', instructions: `Na narração em \`narracao\`, ${ref} faz algum destes gestos?`, criteria: GESTURE_CRITERIA }, (a) => {
      const gesture = pick(a);
      if (!gesture || gesture === 'nenhum' || !GESTURES[gesture]) return null;
      return parseActs(narration).some((act) => act.actorId === c.id && act.gesture === gesture)
        ? null
        : `${c.name} ${GESTURES[gesture].label} na narração sem a marca {${c.id}:${gesture}} na mesma frase.`;
    });
    if (life) {
      ask(`vida_${c.id}`, noul(`A narração em \`narracao\` diz que ${ref} se fere, sangra, desmaia ou é curado(a)?`), (a) =>
        yes(a) && !diff.resources.has(c.id) ? `${c.name} se fere ou se cura na narração, mas a vida no estado não mudou (falta update_character).` : null,
      );
    }
    if (!c.isPlayer && view?.sight(c.id) === 'nada') {
      ask(`visao_${c.id}`, noul(`A narração em \`narracao\` descreve a aparência, a expressão ou o que ${ref} faz em silêncio?`), (a) =>
        yes(a) ? `A narração descreve ${strangerLabel(c)}, que o jogador não vê agora.` : null,
      );
    }
    if (!c.isPlayer && view && !view.canSeeThoughts(c.id)) {
      ask(`pensa_${c.id}`, noul(`A narração em \`narracao\` conta o que ${ref} pensa por dentro, além do que diz e faz?`), (a) =>
        yes(a) ? `A narração revela o que ${c.name} pensa, e o jogador não percebe mentes.` : null,
      );
    }
    const unknown = facts.filter((f) => !knowsIt(c, f));
    const leak = (answers: Answers) => topOf(answers[keyOf(`vaza_${c.id}`)], unknown);
    if (unknown.length && !c.isPlayer) {
      ask(`vaza_${c.id}`, { type: 'choice', instructions: `Na narração em \`narracao\`, ${ref} diz ou faz algo que só faria sabendo de um destes fatos?`, criteria: factCriteria(facts) }, (a) => {
        const fact = topOf(a, unknown);
        return fact ? `${c.name} fala ou age sabendo de ${fact.id} («${short(fact.text)}»), que não sabe; mostre como descobriu (share_knowledge) ou reescreva.` : null;
      });
    }
    if (unknown.length) {
      ask(
        `descobre_${c.id}`,
        {
          type: 'choice',
          instructions: `A narração em \`narracao\` mostra ${ref} ficando sabendo do conteúdo de um destes fatos: alguém conta, ou ele ouve, lê ou vê o próprio fato acontecer? Ver alguém cochichar de longe não é saber o que foi dito.`,
          criteria: factCriteria(facts),
        },
        (a, answers) => {
          const fact = topOf(a, unknown);
          // Quem conta o que não sabia já é um vazamento: não é ele quem descobre.
          if (!fact || leak(answers)) return null;
          return `Na narração ${c.name} fica sabendo de ${fact.id}, mas continua sem saber no estado (falta share_knowledge).`;
        },
      );
    }
    if (!c.isPlayer && player) {
      const feeling = c.feelings[player.id];
      if (feeling && Math.abs(feeling.degree) >= 2 && !diff.feelings.has(`${c.id}>${player.id}`)) {
        ask(`trata_${c.id}`, { type: 'choice', instructions: `Na narração em \`narracao\`, como ${ref} trata o jogador?`, criteria: TREAT_CRITERIA }, (a) => {
          const treat = pick(a);
          const opposite = (feeling.degree > 0 && treat === 'mal') || (feeling.degree < 0 && treat === 'bem');
          return opposite
            ? `${c.name} trata o jogador ${treat === 'mal' ? 'com hostilidade' : 'com simpatia'} na narração, ao contrário do que sente por ele («${short(feeling.text)}»); se o sentimento mudou, registre com set_feelings.`
            : null;
        });
      }
      if (!feeling) {
        ask(`reage_${c.id}`, noul(`Na narração em \`narracao\`, ${ref} reage ao jogador: defende, acusa, consola, ri, foge ou se encolhe por causa dele?`), (a) =>
          yes(a) ? `${c.name} reage ao jogador na narração, mas não tem sentimento registrado por ele (falta set_feelings).` : null,
        );
      }
    }
  }

  // Itens da cena que a narração cita: arma sacada ou guardada, objeto que muda de mãos ou some.
  if (here) {
    for (const item of Object.values(world.items).filter((i) => inScene(i, here, world, before) && itemMentioned(i, story))) {
      const where = holderText(world, item);
      if (gripOf(item) !== 'objeto') {
        ask(`arma_${item.id}`, { type: 'choice', instructions: `Na narração em \`narracao\`, o que acontece com ${item.name} (${where})?`, criteria: WEAPON_CRITERIA }, (a) => {
          const what = pick(a);
          if ((what === 'sacada' || what === 'guardada') && !diff.items.has(item.id)) {
            return `${item.name} é ${what} na narração sem transfer_item (com hand para empunhar, sem hand para guardar).`;
          }
          const holder = world.items[item.id]?.holder;
          if (what === 'ataque' && !(holder?.kind === 'character' && holder.hand)) return `${item.name} é usada para atacar na narração, mas não está na mão de ninguém.`;
          return null;
        });
      } else {
        ask(`item_${item.id}`, noul(`A narração em \`narracao\` diz que ${item.name} (${where}) muda de mãos, é guardado, consumido ou destruído?`), (a) =>
          yes(a) && !diff.items.has(item.id) ? `${item.name} muda de mãos ou some na narração, sem a mudança no estado (falta transfer_item ou update_item).` : null,
        );
      }
    }
  }

  // Testes do motor narrados ao contrário.
  changes
    .map((s) => s.match(/^🎲 (.+?): .*→ (sucesso pleno|sucesso|falha grave|falha)$/))
    .forEach((m, i) => {
      if (!m) return;
      const success = m[2].startsWith('sucesso');
      ask(`teste_${i}`, { type: 'choice', instructions: `Na narração em \`narracao\`, como termina a tentativa «${m[1]}»?`, criteria: TEST_CRITERIA }, (a) => {
        const told = pick(a);
        return (told === 'sucesso' && !success) || (told === 'fracasso' && success) ? `A narração conta «${m[1]}» como ${told}, mas o motor decidiu ${m[2]}.` : null;
      });
    });

  // Falas prontas novas do turno: nomes no código; o fato que cada uma conta, no Jev.
  let lineQuestions = 0;
  for (const id of diff.lines) {
    const c = world.characters[id];
    if (!c?.lines) continue;
    // Só as falas novas: o começo do turno limpa as do turno, e as gerais que ficaram já foram conferidas.
    const old = before.characters[id]?.lines;
    const seen = new Set([...(old?.turn ?? []), ...(old?.general ?? [])].map((l) => l.text));
    for (const [n, line] of [...c.lines.turn, ...c.lines.general].entries()) {
      if (seen.has(line.text)) continue;
      for (const { who: other, name } of nameLeaks(world, line.text, line.introduces ? c.id : null)) {
        code.push(`A fala pronta de ${c.name} «${short(line.text)}» chama pelo nome ${name}, que o jogador não conhece (para ele é "${strangerLabel(other)}").`);
      }
      const unknownToSpeaker = facts.filter((f) => !knowsIt(c, f));
      const unmarked = facts.filter((f) => knowsIt(c, f) && f.id !== line.fact && player !== null && !engine.knows(player.id, f));
      if ((!unknownToSpeaker.length && !unmarked.length) || lineQuestions >= 30) continue;
      lineQuestions++;
      askLine(`fala_${c.id}_${n}`, { type: 'choice', instructions: `Que fato a fala «${line.text}», de ${who(world, c)}, conta ou usa?`, criteria: factCriteria(facts) }, (a) => {
        const leak = topOf(a, unknownToSpeaker);
        if (leak) return `A fala pronta de ${c.name} «${short(line.text)}» usa ${leak.id}, que ${c.name} não sabe; troque a fala.`;
        const reveal = topOf(a, unmarked);
        if (reveal) return `A fala pronta de ${c.name} «${short(line.text)}» conta ${reveal.id} sem a marca fact_id; marque, para quem ouvir passar a saber.`;
        return null;
      });
    }
  }

  // O texto inteiro.
  ask('tu', noul('A narração em `narracao` trata o jogador por "tu" (formas como "voltas", "teu", "estás"), em vez de "você"?'), (a) =>
    yes(a) ? 'A narração trata o jogador por "tu" (voltas, teu, estás); escreva com "você".' : null,
  );
  ask('tempo', noul('A narração em `narracao` diz que passa bastante tempo (meia hora ou mais) ou que o horário muda?'), (a) =>
    yes(a) && diff.minutes < 30 ? 'A narração faz o tempo passar, mas o relógio não andou (falta advance_time).' : null,
  );
  ask('escrita', noul('A narração em `narracao` diz o texto que alguém escreve num quadro, bilhete, papel, parede ou tela, para alguém ler depois?'), (a) =>
    yes(a) && !diff.written.size ? 'Algo é escrito na narração sem o texto no estado (falta update_fixture ou update_item).' : null,
  );
  ask('pessoa_nova', noul('A narração em `narracao` chama pelo nome próprio alguém que não está em `nomes_no_mundo`?'), (a) =>
    yes(a) && !diff.created.size ? 'Surge na narração alguém com nome próprio que não existe no estado (falta create_characters).' : null,
  );
  ask('objeto_novo', noul('A narração em `narracao` mostra um objeto surgindo (alguém tira do bolso, acha ou recebe) que não está em `objetos_no_mundo`?'), (a) =>
    yes(a) && !diff.createdItems.size ? 'Um objeto surge na narração sem existir no estado (falta create_items).' : null,
  );
  if (life) {
    ask('vida_exata', noul('A narração em `narracao` diz o número exato de vida ou de pontos de vida de alguém que não é o jogador?'), (a) =>
      yes(a) ? 'A narração mostra a vida exata de alguém, um valor que o jogador não vê.' : null,
    );
  }

  // O que depende da ação do jogador vai num pedido à parte, com ela.
  if (player && here) {
    const reach = Object.values(world.items).filter((i) => inScene(i, here, world, before) || (i.holder.kind === 'character' && i.holder.id === player.id));
    const criteria = { nenhum: 'nenhum objeto', ...Object.fromEntries(reach.slice(0, 80).map((i) => [keyOf(i.id), i.name])), outro: 'um objeto que não está nesta lista' };
    askAction('objeto_usado', { type: 'choice', instructions: 'Na ação em `acao_do_jogador`, que objeto o jogador usa?', criteria });
    askAction('acao_funciona', noul('Na narração em `narracao`, a ação do jogador dá certo?'));
  }
  if (player && npcs.length) {
    askAction('agressao', noul('Em `acao_do_jogador`, o jogador agride alguém, rouba, foge ou faz algo que alguém em cena tentaria impedir ou punir?'));
    for (const c of npcs) {
      const ref = who(world, c);
      askAction(`deve_${c.id}`, noul(`Pelo papel, pelo que pensa e pelo que quer (veja \`pessoas\`), ${ref} tem o dever ou um motivo forte para agir contra o que o jogador fez em \`acao_do_jogador\`?`));
      askAction(`age_${c.id}`, noul(`Na narração em \`narracao\`, ${ref} age contra o jogador: impede, segura, prende, ataca ou chama ajuda?`));
    }
  }
  const thought = parsePlayerInput(action)
    .filter((s) => s.kind === 'pensamento')
    .map((s) => s.text)
    .join(' ');
  if (thought && player && !npcs.some((c) => perceptionOf(world, c.id).canSeeThoughts(player.id))) {
    askAction('pensamento', noul(`Na narração em \`narracao\`, alguém reage ao pensamento do jogador «${short(thought)}» como se o tivesse ouvido?`), (a) =>
      yes(a) ? 'Um NPC reage ao pensamento do jogador, e ninguém em cena percebe mentes: pensamento não se ouve.' : null,
    );
  }

  const people = present.map((c) =>
    c.isPlayer ? { id: c.id, nome: c.name, e_o_jogador: true } : { id: c.id, nome: c.name, para_o_jogador: knowsName(world, player?.id ?? null, c.id) ? c.name : strangerLabel(c) },
  );
  const narrationState = {
    narracao: story,
    acoes_sugeridas: options,
    pessoas: people,
    nomes_no_mundo: Object.values(world.characters).map((c) => c.name),
    objetos_no_mundo: Object.values(world.items)
      .slice(0, 200)
      .map((i) => i.name),
  };
  const actionState = {
    acao_do_jogador: action,
    narracao: story,
    pessoas: present.map((c) => (c.isPlayer ? { id: c.id, nome: c.name, e_o_jogador: true } : { id: c.id, nome: c.name, papel: c.role, pensa: c.thoughts ?? undefined, quer: c.goals ?? undefined })),
  };

  const judge = (answers: Answers): string[] => {
    const issues = [...probes, ...actionProbes, ...lineProbes].map((p) => p.judge(answers[p.key], answers)).filter((issue): issue is string => issue !== null);
    if (yes(answers.agressao)) {
      for (const c of npcs) {
        if (yes(answers[keyOf(`deve_${c.id}`)]) && no(answers[keyOf(`age_${c.id}`)])) {
          issues.push(`${c.name} deveria agir contra o que o jogador fez (${c.role}) e na narração só assiste; mostre a reação.`);
        }
      }
    }
    if (pick(answers.objeto_usado) === 'outro' && yes(answers.acao_funciona)) {
      issues.push('O jogador usa na ação um objeto que não tem nem está ao alcance, e a narração deixa a ação dar certo.');
    }
    return [...new Set(issues)];
  };

  const questionsOf = (list: Probe[]) => Object.fromEntries(list.map((p) => [p.key, p.question]));
  return {
    requests: [
      { state: narrationState, questions: questionsOf(probes) },
      { state: actionState, questions: questionsOf(actionProbes) },
      // As falas prontas valem para depois: sem a narração, que puxaria cada fala para o fato dela.
      { state: { pessoas: people }, questions: questionsOf(lineProbes) },
    ],
    code: [...new Set(code)],
    judge,
  };
}
