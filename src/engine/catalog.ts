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
}

export interface SearchOptions {
  category?: string;
  figure?: string;
  limit?: number;
}

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
      const item: CatalogItem = { id, pack: r.pack, src: r.src, category: r.category, desc: r.desc, figure: r.figure, look: r.look, ...(r.sensivel ? { sensivel: true } : {}) };
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
      scored.push({ item, score: score + hits / terms.length });
    }
    scored.sort((a, b) => b.score - a.score || (a.item.desc ?? '').length - (b.item.desc ?? '').length);
    return scored.slice(0, limit).map((s) => s.item);
  }

  /**
   * Modelos para um item pelo nome e pela descrição que o mestre deu ("Carta", "envelope
   * amarelado"): busca pelos dois e prefere o que bate com mais palavras deles, com peso no
   * substantivo de cada um, a primeira palavra (o envelope, não a carta de baralho). Só objetos,
   * armas e acessórios; os dos pacotes de rascunho só quando nenhum outro serve.
   */
  suggest(name: string, description = '', limit = 4): CatalogItem[] {
    const terms = (text: string) => [...new Set(words(text).filter((w) => !STOP.has(w)))];
    const named = terms(name);
    const described = terms(description);
    const pool = new Map<string, Indexed>();
    // Descrição longa ("pasta de papelão com o nome dele na capa…") não passa na busca inteira:
    // o começo dela, que diz o que a coisa é, também entra.
    const queries = [name, description, described.slice(0, 3).join(' '), described.slice(0, 2).join(' ')];
    for (const q of new Set(queries.filter((x) => x.trim()))) {
      for (const item of this.search(q, { limit: 20 })) {
        if (ITEM_CATEGORIES.has(item.category)) pool.set(item.id, this.byId.get(item.id)!);
      }
    }
    const hit = (entry: Indexed, q: string) => Math.max(0, ...entry.seen.map((w) => match(q, w)));
    return [...pool.values()]
      .map((entry) => ({
        item: entry.item,
        score:
          (named.reduce((sum, q, k) => sum + hit(entry, q) * (k === 0 ? 2 : 1), 0) +
            described.reduce((sum, q, k) => sum + hit(entry, q) * (k === 0 ? 2 : 0.5), 0)) *
          (DRAFT_PACKS.has(entry.item.pack) ? 0.5 : 1),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.item.desc ?? '').length - (b.item.desc ?? '').length)
      .slice(0, limit)
      .map((x) => x.item);
  }
}

/** Palavras que só ligam as outras e não dizem o que a coisa é. */
const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'com', 'sem', 'um', 'uma', 'uns', 'umas', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'os', 'as', 'ao', 'que']);

/**
 * Pacotes de rascunho, para montar fases antes da arte: blocos laranja, armas "de protótipo" e
 * bilhetes de 50 cm escritos BUG e WIP. Para o mestre escolher, aparecem na busca como os outros.
 */
const DRAFT_PACKS = new Set(['prototype']);

/** O que pode ser item: o resto (construção, ambiente, veículo, personagem, animal) não cabe na mão. */
const ITEM_CATEGORIES = new Set(['objeto', 'arma', 'acessorio']);

let current: ModelCatalog | null = null;

/** O catálogo carregado pelo servidor (ou por um teste); null sem o repertório. */
export function modelCatalog(): ModelCatalog | null {
  return current;
}

export function setModelCatalog(catalog: ModelCatalog | null): void {
  current = catalog;
}
