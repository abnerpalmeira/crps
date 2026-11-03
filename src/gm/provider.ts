import type { z } from 'zod';
import type { ToolSpec } from '../engine/tools';

/**
 * Fronteira entre o mestre e o provedor de modelo. O loop do mestre só conhece
 * isto; detalhes do Claude (thinking, cache, fallbacks) ficam em claude.ts.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type StepStop = 'tool_use' | 'end_turn' | 'refusal' | 'max_tokens' | 'other';

export interface Usage {
  /** Modelo que atendeu (pode ser um fallback), para calcular custo por modelo. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StepResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StepStop;
  refusalCategory?: string | null;
  usage?: Usage;
}

export interface StepHandlers {
  onText?(delta: string): void;
  /** A resposta foi descartada e será pedida de novo; texto já transmitido deve sumir. */
  onRetry?(): void;
}

export interface ModelSession {
  step(handlers?: StepHandlers): Promise<StepResult>;
  addToolResults(results: { id: string; content: string; isError: boolean }[]): void;
  addUserText(text: string): void;
}

export interface SessionOptions {
  system: string;
  tools: ToolSpec[];
  userMessage: string;
  effort: Effort;
}

export interface Verdict {
  consistent: boolean;
  issues: string[];
}

/** Um pedido de resposta estruturada, sem tools: o escritor manda o turno inteiro num JSON. */
export interface WriteOptions {
  system: string;
  prompt: string;
  /** Esquema da resposta: o provedor o passa ao modelo e valida o que voltar. */
  schema: z.ZodType;
  /** Nome do esquema, para os serviços que pedem um. */
  name: string;
  effort: Effort;
}

export interface WriteResult {
  /** A resposta validada pelo esquema; null se veio fora dele ou o modelo recusou. */
  data: unknown | null;
  usage?: Usage;
}

export interface ModelProvider {
  readonly label: string;
  startSession(opts: SessionOptions): ModelSession;
  /** Juiz barato que compara narração e estado. */
  verify(prompt: string): Promise<{ verdict: Verdict; usage?: Usage }>;
  /** Uma chamada só, sem tools, com a resposta no esquema pedido. Sem isso, não há escritor. */
  write?(opts: WriteOptions): Promise<WriteResult>;
}
