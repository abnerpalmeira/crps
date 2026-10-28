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

export interface ModelProvider {
  readonly label: string;
  startSession(opts: SessionOptions): ModelSession;
  /** Juiz barato que compara narração e estado. */
  verify(prompt: string): Promise<Verdict>;
}
