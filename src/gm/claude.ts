import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { ModelProvider, ModelSession, SessionOptions, StepHandlers, StepResult, StepStop, Usage, Verdict } from './provider';

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_VERIFIER_MODEL = 'claude-haiku-5-5';

/** Tipos de bloco do modelo que recusou e que não devem voltar após um fallback no meio da resposta. */
const DROP_BEFORE_FALLBACK = new Set(['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use']);

const VerdictSchema = z.object({
  consistent: z.boolean(),
  issues: z.array(z.string()),
});

export interface ClaudeOptions {
  model?: string;
  /** Pede fallback no servidor quando o modelo recusa (padrão: sim; o Haiku 5.5 não tem). */
  fallback?: boolean;
  verifierModel?: string;
  maxTokens?: number;
  client?: Anthropic;
}

export class ClaudeProvider implements ModelProvider {
  readonly label: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly fallback: boolean;
  private readonly verifierModel: string;
  private readonly maxTokens: number;

  constructor(opts: ClaudeOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model || DEFAULT_MODEL;
    this.fallback = opts.fallback ?? true;
    this.verifierModel = opts.verifierModel || DEFAULT_VERIFIER_MODEL;
    this.maxTokens = opts.maxTokens ?? 64000;
    this.label = this.model;
  }

  startSession(opts: SessionOptions): ModelSession {
    return new ClaudeSession(this.client, this.model, this.fallback, this.maxTokens, opts);
  }

  async verify(prompt: string): Promise<{ verdict: Verdict; usage: Usage }> {
    const response = await this.client.messages.parse({
      model: this.verifierModel,
      max_tokens: 4000,
      output_config: { effort: 'low', format: zodOutputFormat(VerdictSchema) },
      messages: [{ role: 'user', content: prompt }],
    });
    const usage: Usage = {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    // Na dúvida o verificador não trava o jogo.
    if (response.stop_reason === 'refusal' || !response.parsed_output) return { verdict: { consistent: true, issues: [] }, usage };
    return { verdict: response.parsed_output, usage };
  }
}

class ClaudeSession implements ModelSession {
  private readonly messages: Anthropic.Beta.BetaMessageParam[];
  private readonly tools: Anthropic.Beta.BetaTool[];

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly fallback: boolean,
    private readonly maxTokens: number,
    private readonly opts: SessionOptions,
  ) {
    this.messages = [{ role: 'user', content: opts.userMessage }];
    // Inputs chegam conforme são gerados; quem valida é o motor (zod em runTool).
    this.tools = opts.tools.map((t) => ({ ...t, eager_input_streaming: true }));
  }

  async step(handlers: StepHandlers = {}): Promise<StepResult> {
    for (let attempt = 0; ; attempt++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(this.fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        // Ferramentas + sistema são estáticos: um ponto de cache fixo, e o automático cobre a conversa.
        system: [{ type: 'text', text: this.opts.system, cache_control: { type: 'ephemeral' } }],
        cache_control: { type: 'ephemeral' },
        tools: this.tools,
        output_config: { effort: this.opts.effort },
        messages: this.messages,
      });
      stream.on('text', (delta) => handlers.onText?.(delta));

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
      } catch (err) {
        // Só o JSON de tool impossível de parsear é repetido; erros da API sobem.
        if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
        handlers.onRetry?.();
        continue;
      }

      const usage: Usage = {
        model: message.model,
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      };
      if (message.stop_reason === 'refusal') {
        return { text: '', toolCalls: [], stop: 'refusal', refusalCategory: message.stop_details?.category ?? null, usage };
      }

      const content = echoable(message.content);
      this.messages.push({ role: 'assistant', content });
      const text = content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolCalls = content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input }));
      return { text, toolCalls, stop: mapStop(message.stop_reason, toolCalls.length > 0), usage };
    }
  }

  addToolResults(results: { id: string; content: string; isError: boolean }[]): void {
    this.messages.push({
      role: 'user',
      content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })),
    });
  }

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }
}

/** Depois de um fallback no meio da resposta, o que o modelo que recusou gerou (exceto texto) não volta. */
function echoable(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlock[] {
  const boundary = content.map((b) => b.type).lastIndexOf('fallback');
  if (boundary < 0) return content;
  return content.filter((b, i) => i > boundary || !DROP_BEFORE_FALLBACK.has(b.type));
}

function mapStop(reason: Anthropic.Beta.BetaMessage['stop_reason'], hasTools: boolean): StepStop {
  switch (reason) {
    case 'tool_use':
      return hasTools ? 'tool_use' : 'other';
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'other';
  }
}
