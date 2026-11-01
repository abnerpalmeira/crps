import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { modelAvailable, serviceOf } from '../src/gm/models';
import { OpenAICompatibleProvider, ProviderHttpError, type OpenAICompatibleOptions } from '../src/gm/openai';
import { usageCost } from '../src/gm/pricing';
import { describeError, providerFor, reloadServiceKeys } from '../src/gm/runtime';

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Resposta em SSE, picada em pedaços de 17 bytes: as linhas chegam quebradas, como na rede. */
function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < bytes.length; i += 17) ctrl.enqueue(bytes.slice(i, i + 17));
        ctrl.close();
      },
    }),
    { status: 200 },
  );
}

function fakeFetch(responses: Response[], calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    return responses.shift()!;
  }) as typeof fetch;
}

function venice(responses: Response[], calls: Call[], over: Partial<OpenAICompatibleOptions> = {}) {
  return new OpenAICompatibleProvider({
    service: 'venice',
    label: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiKey: () => 'chave-de-teste',
    keyEnv: 'VENICE_API_KEY',
    model: 'deepseek-v4-1-flash-uncensored',
    extra: { venice_parameters: { include_venice_system_prompt: false } },
    fetch: fakeFetch(responses, calls),
    ...over,
  });
}

const TOOLS = [{ name: 'advance_time', description: 'Avança o relógio.', input_schema: { type: 'object' as const, properties: { minutes: { type: 'number' } } } }];

afterEach(() => {
  delete process.env.VENICE_API_KEY;
});

describe('provider compatível com a OpenAI', () => {
  it('junta as tools que chegam em pedaços, guarda o raciocínio e conta o cache', async () => {
    const calls: Call[] = [];
    const first = sse([
      { choices: [{ delta: { reasoning_content: 'O jogador quer esperar.' } }] },
      { choices: [{ delta: { content: 'Vou ' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'advance_time', arguments: '{"min' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'utes": 5}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'advance_time', arguments: '{não é json' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } } },
    ]);
    const second = sse([
      { choices: [{ delta: { content: '<think>rascunho</think>Cinco minutos ' } }] },
      { choices: [{ delta: { content: 'se passam.' }, finish_reason: 'stop' }] },
    ]);
    const session = venice([first, second], calls).startSession({ system: 'Você é o mestre.', tools: TOOLS, userMessage: 'Espero.', effort: 'low' });
    const streamed: string[] = [];
    const r = await session.step({ onText: (d) => streamed.push(d) });
    expect(r.stop).toBe('tool_use');
    expect(r.text).toBe('Vou ');
    expect(streamed).toEqual(['Vou ']);
    // Argumento que não é JSON vai como texto: o motor recusa e o modelo corrige.
    expect(r.toolCalls).toEqual([
      { id: 'call_a', name: 'advance_time', input: { minutes: 5 } },
      { id: 'call_b', name: 'advance_time', input: '{não é json' },
    ]);
    expect(r.usage).toEqual({ model: 'venice/deepseek-v4-1-flash-uncensored', inputTokens: 200, outputTokens: 50, cacheReadTokens: 800, cacheWriteTokens: 0 });

    const sent = calls[0];
    expect(sent.url).toBe('https://api.venice.ai/api/v1/chat/completions');
    expect(sent.headers.Authorization).toBe('Bearer chave-de-teste');
    expect(sent.body).toMatchObject({
      model: 'deepseek-v4-1-flash-uncensored',
      stream: true,
      stream_options: { include_usage: true },
      tool_choice: 'auto',
      reasoning_effort: 'low',
      venice_parameters: { include_venice_system_prompt: false },
      tools: [{ type: 'function', function: { name: 'advance_time', description: 'Avança o relógio.', parameters: TOOLS[0].input_schema } }],
      messages: [
        { role: 'system', content: 'Você é o mestre.' },
        { role: 'user', content: 'Espero.' },
      ],
    });

    session.addToolResults([
      { id: 'call_a', content: '{"to":"08:05"}', isError: false },
      { id: 'call_b', content: 'Entrada inválida', isError: true },
    ]);
    const r2 = await session.step();
    // O rascunho entre <think> não é narração.
    expect(r2).toMatchObject({ text: 'Cinco minutos se passam.', toolCalls: [], stop: 'end_turn' });
    // A resposta com as tools volta como veio, com o raciocínio, e cada resultado vai com o id da chamada.
    expect((calls[1].body.messages as unknown[]).slice(2)).toEqual([
      {
        role: 'assistant',
        content: 'Vou ',
        reasoning_content: 'O jogador quer esperar.',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'advance_time', arguments: '{"minutes": 5}' } },
          { id: 'call_b', type: 'function', function: { name: 'advance_time', arguments: '{não é json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"to":"08:05"}' },
      { role: 'tool', tool_call_id: 'call_b', content: 'ERRO: Entrada inválida' },
    ]);
  });

  it('lista ou objeto que chega como texto JSON vira lista ou objeto onde o esquema pede', async () => {
    const schema = {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        known_by: { anyOf: [{ type: 'string', const: 'all' }, { type: 'string', const: 'present' }, { type: 'array', items: { type: 'string' } }] },
        position: { type: 'object', properties: { near: { type: 'string' } } },
      },
    };
    const args = [
      { text: '[sussurra] o selo é falso', known_by: '["bernardo", "gervasio"]', position: '{"near": "balcao"}' },
      { text: 'Chove.', known_by: 'present' },
    ];
    const calls: Call[] = [];
    const p = venice(
      [
        sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'add_fact', arguments: JSON.stringify(args[0]) } }] } }] },
          // A entrada inteira como texto JSON dentro do texto.
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'add_fact', arguments: JSON.stringify(JSON.stringify(args[1])) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
      ],
      calls,
    );
    const r = await p.startSession({ system: 's', tools: [{ name: 'add_fact', description: '', input_schema: schema }], userMessage: 'u', effort: 'low' }).step();
    expect(r.toolCalls.map((c) => c.input)).toEqual([
      { text: '[sussurra] o selo é falso', known_by: ['bernardo', 'gervasio'], position: { near: 'balcao' } },
      { text: 'Chove.', known_by: 'present' },
    ]);
  });

  it('o fim da resposta diz o que aconteceu: limite de tokens, filtro de conteúdo', async () => {
    const calls: Call[] = [];
    const p = venice([sse([{ choices: [{ delta: { content: 'A' }, finish_reason: 'length' }] }]), sse([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }])], calls);
    const opts = { system: 's', tools: TOOLS, userMessage: 'u', effort: 'low' as const };
    expect((await p.startSession(opts).step()).stop).toBe('max_tokens');
    expect((await p.startSession(opts).step()).stop).toBe('refusal');
  });

  it('o verificador responde no esquema; fora dele, não trava o jogo', async () => {
    const calls: Call[] = [];
    const json = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const p = venice([json('{"consistent": false, "issues": ["Abelardo andou sem move_character."]}'), json('não sei')], calls);
    expect((await p.verify('compare')).verdict).toEqual({ consistent: false, issues: ['Abelardo andou sem move_character.'] });
    expect(calls[0].body).toMatchObject({ response_format: { type: 'json_schema', json_schema: { name: 'verdict', strict: true } }, reasoning_effort: 'low' });
    expect((await p.verify('compare')).verdict).toEqual({ consistent: true, issues: [] });
  });

  it('sem chave, ou com a chave recusada, o erro diz o que fazer', async () => {
    const calls: Call[] = [];
    const missing = venice([], calls, { apiKey: () => undefined }).startSession({ system: 's', tools: [], userMessage: 'u', effort: 'low' });
    const err = await missing.step().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(describeError(err)).toBe('A Venice recusou a chave (401): Falta a chave da Venice: defina VENICE_API_KEY no .env.');
    expect(calls).toEqual([]);
    const refused = venice([new Response(JSON.stringify({ error: 'Invalid API key' }), { status: 401 })], calls);
    expect(describeError(await refused.verify('x').catch((e: unknown) => e))).toBe('A Venice recusou a chave (401): Invalid API key');
  });

  it('o id do modelo escolhe o serviço; o seletor só oferece o que tem chave; o custo usa o preço dele', () => {
    expect(serviceOf('venice/deepseek-v4-1-flash-uncensored')?.model).toBe('deepseek-v4-1-flash-uncensored');
    expect(serviceOf('claude-haiku-5-5')).toBeNull();
    const p = providerFor('venice/deepseek-v4-1-flash-uncensored');
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.label).toBe('venice/deepseek-v4-1-flash-uncensored');
    expect(modelAvailable('venice/deepseek-v4-1-flash-uncensored')).toBe(false);
    process.env.VENICE_API_KEY = 'x';
    expect(modelAvailable('venice/deepseek-v4-1-flash-uncensored')).toBe(true);
    expect(modelAvailable('claude-haiku-5-5')).toBe(true);
    // 1 milhão de tokens de cada: entrada, saída e lidos do cache.
    expect(usageCost({ model: 'venice/deepseek-v4-1-flash-uncensored', inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 })).toBeCloseTo(0.33 + 1.32 + 0.00825);
  });

  it('a chave posta ou trocada no .env com o servidor no ar vale; a do ambiente continua', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crps-'));
    const file = join(dir, '.env');
    try {
      writeFileSync(file, 'VENICE_API_KEY=do-arquivo\nCRPS_TESTE_SO_NA_PARTIDA=1\n');
      process.env.VENICE_API_KEY = 'do-ambiente';
      reloadServiceKeys(file);
      expect(process.env.VENICE_API_KEY).toBe('do-ambiente');
      delete process.env.VENICE_API_KEY;
      reloadServiceKeys(file);
      expect(process.env.VENICE_API_KEY).toBe('do-arquivo');
      writeFileSync(file, 'VENICE_API_KEY=trocada\n');
      reloadServiceKeys(file);
      expect(process.env.VENICE_API_KEY).toBe('trocada');
      // Só as chaves dos serviços: o resto do .env é lido uma vez, na partida.
      expect(process.env.CRPS_TESTE_SO_NA_PARTIDA).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
