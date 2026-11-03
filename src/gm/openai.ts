import { z } from 'zod';
import type { ModelProvider, ModelSession, SessionOptions, StepHandlers, StepResult, StepStop, Usage, Verdict, WriteOptions, WriteResult } from './provider';

/**
 * Provedor compatível com a API de chat da OpenAI (Venice e outros serviços): POST
 * {baseUrl}/chat/completions, com as tools do motor como funções e a resposta em streaming (SSE).
 * O que é de cada serviço vem em `extra`, somado ao corpo de toda chamada.
 */
export interface OpenAICompatibleOptions {
  /** Prefixo do serviço nos ids ("venice"): vira o rótulo e o modelo dos custos. */
  service: string;
  label: string;
  baseUrl: string;
  /** A chave, lida a cada chamada: trocada no .env com o servidor no ar, já vale. */
  apiKey: () => string | undefined;
  /** Variável de ambiente da chave, para dizer onde ela falta. */
  keyEnv: string;
  model: string;
  verifierModel?: string;
  maxTokens?: number;
  extra?: Record<string, unknown>;
  /** Para os testes: um fetch falso. */
  fetch?: typeof fetch;
}

/** Erro HTTP de um serviço: a mensagem dele, com o status. */
export class ProviderHttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: { consistent: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } },
  required: ['consistent', 'issues'],
  additionalProperties: false,
};

/** Uso como os serviços compatíveis contam: a entrada inclui o que veio do cache. */
interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_creation_input_tokens?: number } | null;
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly label: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.label = `${opts.service}/${opts.model}`;
  }

  startSession(session: SessionOptions): ModelSession {
    return new OpenAISession(this, this.opts.model, session);
  }

  async verify(prompt: string): Promise<{ verdict: Verdict; usage?: Usage }> {
    const model = this.opts.verifierModel ?? this.opts.model;
    const data = (await (
      await this.post({
        model,
        messages: [{ role: 'user', content: prompt }],
        // O raciocínio conta na saída: com 4000, como no Claude, o DeepSeek parava antes do veredito.
        max_completion_tokens: 16000,
        reasoning_effort: 'low',
        response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA } },
      })
    ).json()) as { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; usage?: RawUsage };
    const usage = this.usage(model, data.usage);
    const content = data.choices?.[0]?.message?.content ?? '';
    try {
      const parsed = JSON.parse(stripThinking(content)) as Partial<Verdict>;
      if (typeof parsed.consistent !== 'boolean' || !Array.isArray(parsed.issues)) throw new Error('fora do esquema');
      return { verdict: { consistent: parsed.consistent, issues: parsed.issues.map(String) }, usage };
    } catch {
      // Na dúvida o verificador não trava o jogo, mas o log diz que ele não verificou.
      console.warn(`[crps] veredito ilegível de ${this.label} (fim: ${data.choices?.[0]?.finish_reason ?? '?'}): ${content.slice(0, 200) || '(vazio)'}`);
      return { verdict: { consistent: true, issues: [] }, usage };
    }
  }

  /** O escritor: uma chamada sem tools, com a resposta no esquema estrito; o que vier fora dele é null. */
  async write(opts: WriteOptions): Promise<WriteResult> {
    const model = this.opts.model;
    const data = (await (
      await this.post({
        model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.prompt },
        ],
        max_completion_tokens: this.maxTokens,
        reasoning_effort: opts.effort,
        response_format: { type: 'json_schema', json_schema: { name: opts.name, strict: true, schema: strictSchema(opts.schema) } },
        prompt_cache_key: `crps-${fnv(opts.system)}`,
      })
    ).json()) as { choices?: { finish_reason?: string; message?: { content?: string | null } }[]; usage?: RawUsage };
    const usage = this.usage(model, data.usage);
    const content = data.choices?.[0]?.message?.content ?? '';
    try {
      const parsed = opts.schema.safeParse(JSON.parse(unfence(stripThinking(content))));
      if (parsed.success) return { data: parsed.data, usage };
    } catch {
      // JSON quebrado: segue para o aviso
    }
    console.warn(`[crps] resposta do escritor fora do esquema em ${this.label} (fim: ${data.choices?.[0]?.finish_reason ?? '?'}): ${content.slice(0, 200) || '(vazio)'}`);
    return { data: null, usage };
  }

  /** POST no endpoint de chat; erro do serviço sobe com a mensagem dele. */
  async post(body: Record<string, unknown>): Promise<Response> {
    const key = this.opts.apiKey();
    if (!key) throw new ProviderHttpError(this.opts.service, 401, `Falta a chave da ${this.opts.label}: defina ${this.opts.keyEnv} no .env.`);
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...this.opts.extra, ...body }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text.slice(0, 300) || res.statusText;
      try {
        const parsed = JSON.parse(text) as { error?: string | { message?: string }; message?: string };
        message = (typeof parsed.error === 'string' ? parsed.error : parsed.error?.message) ?? parsed.message ?? message;
      } catch {
        // corpo que não é JSON: vai como veio
      }
      throw new ProviderHttpError(this.opts.service, res.status, message);
    }
    return res;
  }

  get maxTokens(): number {
    return this.opts.maxTokens ?? 32000;
  }

  /** Uso no formato do motor: a entrada sem o que foi lido ou gravado no cache. */
  usage(model: string, raw: RawUsage | null | undefined): Usage {
    const cached = raw?.prompt_tokens_details?.cached_tokens ?? 0;
    const written = raw?.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
    return {
      model: `${this.opts.service}/${model}`,
      inputTokens: Math.max(0, (raw?.prompt_tokens ?? 0) - cached - written),
      outputTokens: raw?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: written,
    };
  }
}

/** Uma conversa: o sistema, a mensagem do turno e cada resposta e resultado de tool, na ordem. */
class OpenAISession implements ModelSession {
  private readonly messages: Record<string, unknown>[];
  private readonly tools: Record<string, unknown>[];
  private readonly schemas: Map<string, JsonSchema>;

  constructor(
    private readonly provider: OpenAICompatibleProvider,
    private readonly model: string,
    private readonly opts: SessionOptions,
  ) {
    this.messages = [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.userMessage },
    ];
    this.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    this.schemas = new Map(opts.tools.map((t) => [t.name, t.input_schema as JsonSchema]));
  }

  async step(handlers: StepHandlers = {}): Promise<StepResult> {
    const res = await this.provider.post({
      model: this.model,
      messages: this.messages,
      tools: this.tools,
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: this.opts.effort,
      max_completion_tokens: this.provider.maxTokens,
      // O sistema e as tools são os mesmos o turno inteiro: a mesma chave ajuda o cache.
      prompt_cache_key: `crps-${fnv(this.opts.system)}`,
    });
    let text = '';
    let reasoning = '';
    const details: unknown[] = [];
    const calls: { id: string; name: string; args: string }[] = [];
    let finish: string | null = null;
    let raw: RawUsage | null = null;
    for await (const chunk of events(res)) {
      if (chunk.error) throw new ProviderHttpError('stream', 500, typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'erro no meio da resposta'));
      if (chunk.usage) raw = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (delta.content) {
        text += delta.content;
        handlers.onText?.(delta.content);
      }
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (Array.isArray(delta.reasoning_details)) details.push(...delta.reasoning_details);
      // As chamadas de tool chegam em pedaços, pelo índice: id e nome no primeiro, argumentos aos poucos.
      for (const tc of delta.tool_calls ?? []) {
        const slot = (calls[tc.index ?? calls.length] ??= { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const usage = this.provider.usage(this.model, raw);
    const toolCalls = calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, args: c.args || '{}' }));
    // A resposta volta para a conversa como veio, com o raciocínio (o serviço pede de volta entre tools).
    this.messages.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(details.length ? { reasoning_details: details } : {}),
    });
    return {
      text: stripThinking(text),
      // Argumento que não é JSON vai como texto: o motor recusa com a mensagem do zod, e o modelo corrige.
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, input: unstring(parseArgs(c.args), this.schemas.get(c.name)) })),
      stop: mapStop(finish, toolCalls.length > 0),
      usage,
    };
  }

  addToolResults(results: { id: string; content: string; isError: boolean }[]): void {
    for (const r of results) this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERRO: ${r.content}` : r.content });
  }

  addUserText(text: string): void {
    this.messages.push({ role: 'user', content: text });
  }
}

interface Chunk {
  error?: string | { message?: string };
  usage?: RawUsage;
  choices?: {
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning_details?: unknown[];
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
  }[];
}

/** Os eventos de um stream SSE ("data: {...}" por linha, até "data: [DONE]"). */
async function* events(res: Response): AsyncGenerator<Chunk> {
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield JSON.parse(data) as Chunk;
    }
  }
}

/** Hash curto e estável de um texto (FNV-1a). */
function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

/** O pedaço do JSON Schema das tools que diz onde vai lista ou objeto. */
interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
}

/**
 * Alguns modelos (o DeepSeek) mandam lista ou objeto como texto JSON: known_by: '["ana","bruno"]'.
 * Onde o esquema da tool pede lista ou objeto e o texto vira um deles, vale o de dentro; texto
 * onde o esquema pede texto fica como veio. O resto quem valida é o motor.
 */
function unstring(value: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return value;
  const forms = schema.anyOf ?? schema.oneOf ?? [schema];
  if (typeof value === 'string') {
    const start = value.trimStart()[0];
    const kind = start === '[' ? 'array' : start === '{' ? 'object' : null;
    if (!kind || !forms.some((f) => wants(f, kind))) return value;
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    const items = forms.find((f) => wants(f, 'array'))?.items;
    return items ? value.map((v) => unstring(v, items)) : value;
  }
  if (value && typeof value === 'object') {
    const form = forms.find((f) => wants(f, 'object'));
    if (!form) return value;
    const rest = typeof form.additionalProperties === 'object' ? form.additionalProperties : undefined;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unstring(v, form.properties?.[k] ?? rest)]));
  }
  return value;
}

function wants(schema: JsonSchema, kind: 'array' | 'object'): boolean {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.includes(kind) || (kind === 'array' ? schema.items !== undefined : schema.properties !== undefined);
}

/** Raciocínio que escapou para o texto, entre <think> e </think>, não é narração. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trimStart();
}

/** O esquema da resposta como o modo estrito pede: o zod já fecha os objetos e exige todos os campos; sai só o ruído. */
function strictSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
  delete js.$schema;
  const noise = (key: string, value: unknown) => (key === 'minimum' || key === 'maximum') && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER;
  return JSON.parse(JSON.stringify(js, (key, value) => (noise(key, value) ? undefined : value)));
}

/** JSON entre cercas de código (```json … ```), como alguns modelos mandam mesmo com o esquema. */
function unfence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function mapStop(finish: string | null, hasTools: boolean): StepStop {
  if (hasTools) return 'tool_use';
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}
