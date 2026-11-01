import type { Usage } from './provider';

/**
 * Cliente do Jev, da TypeSafe: um modelo que só decide. Ele responde perguntas tipadas sobre um
 * estado (escolher uma opção, dar uma nota em níveis, a probabilidade de um sim), todas num pedido
 * e em paralelo, com probabilidades calibradas; não escreve texto. O estado é cobrado uma vez por
 * pedido, então vale juntar as perguntas. Documentação: https://docs.typesafe.ai
 */

export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface JevResult {
  answers: Record<string, JevAnswer>;
  usage: Usage;
  ms: number;
}

export interface JevOptions {
  apiKey?: () => string | undefined;
  /** jev-latest por padrão; a resposta diz qual versão atendeu, e é ela que entra no custo. */
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Prazo do pedido inteiro, com as repetições (padrão: 10 s). */
  timeoutMs?: number;
  /** Espera antes de repetir num 429 ou 529; dobra a cada tentativa (padrão: 250 ms). */
  backoffMs?: number;
}

export const JEV_KEY_ENV = 'TYPESAFE_API_KEY';

export class JevError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class JevClient {
  constructor(private readonly opts: JevOptions = {}) {}

  /** Tem chave; sem ela, quem usa o Jev cai no modelo de texto. */
  get available(): boolean {
    return Boolean(this.key());
  }

  async ask(state: unknown, questions: Record<string, JevQuestion>): Promise<JevResult> {
    const key = this.key();
    if (!key) throw new JevError(401, `Falta a chave do Jev: defina ${JEV_KEY_ENV} no .env.`);
    const started = Date.now();
    const deadline = started + (this.opts.timeoutMs ?? 10_000);
    for (let attempt = 0; ; attempt++) {
      const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl ?? 'https://api.typesafe.ai'}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model ?? 'jev-latest', state, questions }),
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      // Limite de pedidos ou serviço cheio: espera e tenta de novo, enquanto houver prazo.
      const wait = (this.opts.backoffMs ?? 250) * 2 ** attempt;
      if ((res.status === 429 || res.status === 529) && Date.now() + wait < deadline) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new JevError(res.status, `Jev respondeu ${res.status}: ${errorMessage(text) || res.statusText}`);
      const data = JSON.parse(text) as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
      const model = data.model ?? this.opts.model ?? 'jev-latest';
      return {
        answers: data.answers ?? {},
        usage: { model, inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ms: Date.now() - started,
      };
    }
  }

  private key(): string | undefined {
    return (this.opts.apiKey ?? (() => process.env[JEV_KEY_ENV]))() || undefined;
  }
}

function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string | { message?: string }; message?: string; detail?: unknown };
    const error = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    return error ?? parsed.message ?? (typeof parsed.detail === 'string' ? parsed.detail : text.slice(0, 300));
  } catch {
    return text.slice(0, 300);
  }
}

/** Sim com `threshold` ou mais, não com 1 − `threshold` ou menos; no meio, sem opinião (null). */
export function yesNo(answer: JevAnswer | undefined, threshold = 0.8): boolean | null {
  if (answer?.type !== 'noul') return null;
  if (answer.noul >= threshold) return true;
  if (answer.noul <= 1 - threshold) return false;
  return null;
}

/** A opção escolhida, quando a confiança basta; senão, null. */
export function chosen(answer: JevAnswer | undefined, minConfidence = 0.5): string | null {
  return answer?.type === 'choice' && answer.confidence >= minConfidence ? answer.choice : null;
}
