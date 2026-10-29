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
}

let current: ModelCatalog | null = null;

/** O catálogo carregado pelo servidor (ou por um teste); null sem o repertório. */
export function modelCatalog(): ModelCatalog | null {
  return current;
}

export function setModelCatalog(catalog: ModelCatalog | null): void {
  current = catalog;
}
