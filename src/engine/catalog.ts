import { ERA_PEOPLE, PACK_ERA, eraFit } from './eras';
import type { Era } from './types';

/**
 * Catálogo de modelos 3D (o repertório Synty descrito olhando, assets/synty/repertorio.json):
 * o mestre busca por descrição e escolhe o modelo de um tipo de objeto ou o visual de um
 * personagem. Só texto chega ao mestre; os modelos ficam no servidor.
 */

export interface CatalogItem {
  /** `pacote:Arquivo`, ex. "town:SM_Prop_Sofa_02". */
  id: string;
  pack: string;
  /** Caminho do FBX em assets/synty. */
  src: string;
  category: string;
  desc?: string;
  /** Personagens e animais: corpo (adulto, adulta, menino, menina, criatura, animal) e visual. */
  figure?: string;
  look?: string;
  /** Símbolo de ódio ou conteúdo sexual explícito: fora das buscas. */
  sensivel?: boolean;
  /** Largura, altura e profundidade em metros (measure_synty.py), quando medido. */
  size?: [number, number, number];
}

/** Item do repertorio.json, como index_synty.py escreve. */
export interface RepertoireItem {
  id: string;
  pack: string;
  src: string;
  category: string;
  desc?: string;
  figure?: string;
  look?: string;
  sensivel?: boolean;
  size?: [number, number, number];
}

export interface SearchOptions {
  category?: string;
  figure?: string;
  limit?: number;
  /** Época da campanha: os modelos dela (e os atemporais) vêm antes. */
  era?: Era;
}

/** Um visual de personagem, para o mestre escolher e descrever a aparência a partir dele. */
export interface LookOption {
  id: string;
  figure: string;
  look: string;
}

/** Corpos de gente, que as animações do jogo movem. */
const HUMAN = new Set(['adulto', 'adulta', 'menino', 'menina']);

const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

function words(s: string): string[] {
  return fold(s.replace(/([a-z])([A-Z])/g, '$1 $2'))
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** Palavra igual vale mais; uma que começa com a outra (cadeira, cadeiras) vale quase igual. */
function match(q: string, w: string): number {
  if (q === w) return 1;
  if (Math.min(q.length, w.length) >= 4 && (w.startsWith(q) || q.startsWith(w))) return 0.8;
  return 0;
}

interface Indexed {
  item: CatalogItem;
  /** O que quem olhou viu (descrição e visual) pesa mais que o nome do arquivo e o pacote. */
  seen: string[];
  named: string[];
}

export class ModelCatalog {
  private byId = new Map<string, Indexed>();

  constructor(items: RepertoireItem[]) {
    for (const r of items) {
      if (r.category === 'animacao') continue;
      // Personagem exportado para o Unreal usa o esqueleto do Unreal, que as animações do jogo não
      // movem direito (a pessoa sai desmontada); a versão padrão costuma estar fora dessa pasta.
      if (r.category === 'personagem' && /unreal/i.test(r.src)) continue;
      const id = `${r.pack}:${r.id}`;
      const prev = this.byId.get(id);
      // Cópias do mesmo modelo (FBX e Unreal): fica a de fora da pasta do Unreal.
      if (prev && (/unreal/i.test(r.src) || !/unreal/i.test(prev.item.src))) continue;
      const item: CatalogItem = {
        id,
        pack: r.pack,
        src: r.src,
        category: r.category,
        desc: r.desc,
        figure: r.figure,
        look: r.look,
        ...(r.sensivel ? { sensivel: true } : {}),
        ...(r.size ? { size: r.size } : {}),
      };
      this.byId.set(id, { item, seen: words(`${r.desc ?? ''} ${r.look ?? ''}`), named: words(`${r.id.replace(/^(SK|SM)_(Chr|Prop|Env|Bld|Veh|Wep|Item|Gen)_/, '')} ${r.pack}`) });
    }
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): CatalogItem | undefined {
    return this.byId.get(id)?.item;
  }

  /** Os mais parecidos com o texto, sem os sensíveis. */
  search(query: string, opts: SearchOptions = {}): CatalogItem[] {
    const terms = [...new Set(words(query))];
    if (!terms.length) return [];
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 20);
    const scored: { item: CatalogItem; score: number }[] = [];
    for (const { item, seen, named } of this.byId.values()) {
      if (item.sensivel) continue;
      if (opts.category && item.category !== opts.category) continue;
      if (opts.figure && item.figure !== opts.figure) continue;
      let score = 0;
      let hits = 0;
      terms.forEach((q, k) => {
        const s = Math.max(0, ...seen.map((w) => match(q, w)));
        const n = Math.max(0, ...named.map((w) => match(q, w))) * 0.5;
        if (s || n) hits++;
        // A primeira palavra costuma ser o que se procura ("sofá de couro"); o resto, o detalhe.
        score += Math.max(s, n) * (k === 0 ? 1.5 : 1);
      });
      // Pelo menos metade das palavras precisa aparecer.
      if (hits * 2 < terms.length) continue;
      scored.push({ item, score: (score + hits / terms.length) * eraFit(item.pack, opts.era) });
    }
    scored.sort((a, b) => b.score - a.score || (a.item.desc ?? '').length - (b.item.desc ?? '').length);
    return scored.slice(0, limit).map((s) => s.item);
  }

  /**
   * Modelos para um item pelo nome e pela descrição que o mestre deu ("Carta", "envelope
   * amarelado"): busca pelos dois e prefere o que bate com mais palavras deles, com peso no
   * substantivo de cada um, a primeira palavra (o envelope, não a carta de baralho). Só objetos,
   * armas e acessórios que cabem na mão; os dos pacotes de rascunho só quando nenhum outro serve, e
   * os de outra época, quanto mais longe dela, menos.
   */
  suggest(name: string, description = '', limit = 4, era?: Era): CatalogItem[] {
    const terms = (text: string) => [...new Set(words(text).filter((w) => !STOP.has(w)))];
    const named = terms(name);
    const described = terms(description);
    const pool = new Map<string, Indexed>();
    // Descrição longa ("pasta de papelão com o nome dele na capa…") não passa na busca inteira:
    // o começo dela, que diz o que a coisa é, também entra.
    const queries = [name, description, described.slice(0, 3).join(' '), described.slice(0, 2).join(' ')];
    for (const q of new Set(queries.filter((x) => x.trim()))) {
      for (const item of this.search(q, { limit: 20, era })) {
        if (portable(item) && !PART.test(item.id)) pool.set(item.id, this.byId.get(item.id)!);
      }
    }
    const hit = (entry: Indexed, q: string) => Math.max(0, ...entry.seen.map((w) => match(q, w)));
    // A descrição que abre com o que se procura (pelo nome ou pela descrição do mestre) é a coisa
    // ("balde de madeira…"); a que só o cita é outra coisa ou uma peça dela ("alça curva do balde",
    // "lâmina de água para encher a bacia").
    const lead = [named[0], described[0]].filter(Boolean);
    const head = (entry: Indexed) => (entry.seen.length ? Math.max(0, ...lead.map((q) => match(q, entry.seen[0]))) * 2 : 0);
    return [...pool.values()]
      .map((entry) => ({
        item: entry.item,
        score:
          (named.reduce((sum, q, k) => sum + hit(entry, q) * (k === 0 ? 2 : 1), 0) +
            described.reduce((sum, q, k) => sum + hit(entry, q) * (k === 0 ? 2 : 0.5), 0) +
            head(entry)) *
          (DRAFT_PACKS.has(entry.item.pack) ? 0.5 : 1) *
          eraFit(entry.item.pack, era),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.item.desc ?? '').length - (b.item.desc ?? '').length)
      .slice(0, limit)
      .map((x) => x.item);
  }

  /**
   * Visuais de gente da época, para a lista do mestre: primeiro a gente comum dela (ERA_PEOPLE);
   * depois um de cada pacote e corpo por vez, para a lista não ficar só com o pacote maior.
   */
  looks(era: Era, limit = 48): LookOption[] {
    const everyday = ERA_PEOPLE[era] ?? [];
    const rank = (i: CatalogItem) => (everyday.includes(i.pack) ? everyday.indexOf(i.pack) : everyday.length);
    const first: CatalogItem[] = [];
    const groups = new Map<string, CatalogItem[]>();
    const seen = new Set<string>();
    for (const { item } of this.byId.values()) {
      if (item.category !== 'personagem' || item.sensivel || !item.look || !HUMAN.has(item.figure ?? '') || PACK_ERA[item.pack] !== era) continue;
      // O mesmo personagem em dois arquivos (com e sem o prefixo SK_) entra uma vez só.
      if (seen.has(`${item.pack}|${item.look}`)) continue;
      seen.add(`${item.pack}|${item.look}`);
      if (rank(item) < everyday.length) first.push(item);
      else groups.set(`${item.pack}|${item.figure}`, [...(groups.get(`${item.pack}|${item.figure}`) ?? []), item]);
    }
    const out = first.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
    const queues = [...groups.values()];
    while (out.length < limit && queues.some((q) => q.length)) {
      for (const q of queues) {
        const item = q.shift();
        if (item && out.length < limit) out.push(item);
      }
    }
    return out.map((i) => ({ id: i.id, figure: i.figure!, look: i.look! }));
  }
}

/** Palavras que só ligam as outras e não dizem o que a coisa é. */
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'um', 'uma', 'uns', 'umas', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'os', 'as', 'ao', 'que']);

/**
 * Pacotes de rascunho, para montar fases antes da arte: blocos laranja, armas "de protótipo" e
 * bilhetes de 50 cm escritos BUG e WIP. Para o mestre escolher, aparecem na busca como os outros.
 */
const DRAFT_PACKS = new Set(['prototype']);

/** Peça de outro modelo (o encaixe com a água da bacia, a alça do balde, a tampa, a porta), que não é item. */
const PART = /_(Insert|Handle|Lid|Door|Hinge|Latch|Flue)(_|\d|$)/i;

/** O que pode ser item: o resto (construção, ambiente, veículo, personagem, animal) não cabe na mão. */
const ITEM_CATEGORIES = new Set(['objeto', 'arma', 'acessorio']);

/**
 * Tamanho de algo que alguém carrega, na mão ou nos braços: nada passa de 1,6 m (2,6 m numa arma:
 * lança, alabarda), e só uma medida passa de 0,9 m (uma vassoura, um remo).
 */
export function portableSize(size: readonly number[], category: string): boolean {
  const [long, mid] = [...size].sort((a, b) => b - a);
  return long <= (category === 'arma' ? 2.6 : 1.6) && mid <= 0.9;
}

/**
 * Serve de item: objeto, arma ou acessório que cabe na mão. Sem medida, pelo prefixo da Synty:
 * peça de cenário, construção e veículo (SM_Env, SM_Bld, SM_Veh) não se carregam.
 */
export function portable(item: CatalogItem): boolean {
  if (!ITEM_CATEGORIES.has(item.category)) return false;
  if (item.size) return portableSize(item.size, item.category);
  return !/^S[MK]_(Env|Bld|Veh)_/i.test(item.id.slice(item.id.indexOf(':') + 1));
}

/** Medidas para o mestre, em metros: "1,4 × 1,3 × 1,2 m". */
export function sizeLabel(size: readonly number[]): string {
  return `${size.map((v) => (Math.round(v * 10) / 10).toLocaleString('pt-BR')).join(' × ')} m`;
}

let current: ModelCatalog | null = null;

/** O catálogo carregado pelo servidor (ou por um teste); null sem o repertório. */
export function modelCatalog(): ModelCatalog | null {
  return current;
}

export function setModelCatalog(catalog: ModelCatalog | null): void {
  current = catalog;
}

let baseLooks: LookOption[] = [];

/** Os visuais de hoje que vêm convertidos com o jogo (public/models), registrados pelo servidor. */
export function setBaseLooks(looks: LookOption[]): void {
  baseLooks = looks;
}

/**
 * Visuais para a época: os que vêm com o jogo, na atual ou sem época; os do catálogo, nas outras
 * (e os de hoje, se o catálogo não estiver nesta máquina).
 */
export function eraLooks(era: Era | undefined): LookOption[] {
  const own = era && era !== 'atual' ? (current?.looks(era) ?? []) : [];
  return own.length ? own : baseLooks;
}
