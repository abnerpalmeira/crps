import type { Usage } from './provider';

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * US$ por milhão de tokens (tabela da Anthropic, out/2026; gravação de cache de 5 min = 1,25× a entrada).
 * Cache do Haiku estimado em 0,1× e 1,25× da entrada; o Haiku 5.5 sobe para US$ 0,50/2,50 acima de
 * 100 mil tokens de prompt, o que um turno do CRPS não alcança. "offline" é o roteiro da demo, sem custo.
 * Os da Venice vêm da lista de modelos dela (/models, nov/2026); ela não cobra gravar no cache, e
 * a gravação fica com o preço da entrada.
 */
const PRICES: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'venice/deepseek-v4-1-flash-uncensored': { input: 0.33, output: 1.32, cacheRead: 0.00825, cacheWrite: 0.33 },
  offline: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  // O Jev, que confere a narração, cobra só a entrada (docs.typesafe.ai/models, nov/2026).
  jev: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** O preço do modelo; toda versão do Jev ("jev-1.14.0") tem o mesmo. */
function priceFor(model: string): Price | undefined {
  return PRICES[model] ?? (model.startsWith('jev-') ? PRICES.jev : undefined);
}

/** Preço de entrada e saída (US$ por milhão de tokens), para o seletor de modelo. */
export function priceOf(model: string): { input: number; output: number } | null {
  const p = priceFor(model);
  return p ? { input: p.input, output: p.output } : null;
}

export function usageCost(u: Usage): number | null {
  const p = priceFor(u.model);
  if (!p) return null;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) / 1e6;
}

export interface ModelTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
}

export interface TurnCost {
  requests: number;
  usd: number;
  byModel: Record<string, ModelTotals>;
  /** Modelos sem preço na tabela (o custo deles não entra em usd). */
  unpriced: string[];
}

/** Soma o uso de todas as chamadas de um turno: mestre, correções e verificador. */
export class CostMeter {
  private readonly usages: Usage[] = [];

  add(u: Usage): void {
    this.usages.push(u);
  }

  summary(): TurnCost {
    const byModel: Record<string, ModelTotals> = {};
    const unpriced = new Set<string>();
    for (const u of this.usages) {
      const t = (byModel[u.model] ??= { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0 });
      t.requests++;
      t.inputTokens += u.inputTokens;
      t.outputTokens += u.outputTokens;
      t.cacheReadTokens += u.cacheReadTokens;
      t.cacheWriteTokens += u.cacheWriteTokens;
      const cost = usageCost(u);
      if (cost === null) unpriced.add(u.model);
      else t.usd += cost;
    }
    const usd = Object.values(byModel).reduce((sum, t) => sum + t.usd, 0);
    return { requests: this.usages.length, usd, byModel, unpriced: [...unpriced] };
  }
}

/** Créditos cobrados por um custo em US$, sempre arredondados para cima. */
export function toCredits(usd: number, creditUsd: number): number {
  return usd <= 0 ? 0 : Math.ceil(usd / creditUsd - 1e-9);
}

export type Mode = 'dev' | 'release';

/** O que o jogador vê do custo: no dev, US$ e tokens; no release, só créditos. */
export interface CostEvent {
  type: 'cost';
  turn: number;
  credits: number;
  usd?: number;
  detail?: string;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function describeCost(cost: TurnCost): string {
  const models = Object.entries(cost.byModel).map(
    ([model, t]) =>
      `${model} ×${t.requests}: ${k(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} entrada ` +
      `(${k(t.cacheReadTokens)} lidos do cache, ${k(t.cacheWriteTokens)} gravados), ${k(t.outputTokens)} saída`,
  );
  const missing = cost.unpriced.length ? ` · sem preço: ${cost.unpriced.join(', ')}` : '';
  return `${models.join(' · ')}${missing}`;
}

export function costEvent(cost: TurnCost, opts: { mode: Mode; creditUsd: number; turn: number }): CostEvent {
  const credits = toCredits(cost.usd, opts.creditUsd);
  if (opts.mode === 'release') return { type: 'cost', turn: opts.turn, credits };
  return { type: 'cost', turn: opts.turn, credits, usd: cost.usd, detail: describeCost(cost) };
}
