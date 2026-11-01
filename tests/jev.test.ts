import { describe, expect, it } from 'vitest';
import { JevClient, chosen, yesNo } from '../src/gm/jev';
import { priceOf, usageCost } from '../src/gm/pricing';

/** fetch falso: guarda os pedidos e responde na ordem da lista (a última se repete). */
function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const OK = { model: 'jev-1.14.0', answers: { tu: { type: 'noul', noul: 0.94 } }, usage: { input_tokens: 1200, output_tokens: 30 } };

describe('cliente do Jev', () => {
  it('manda o estado e as perguntas com a chave, e devolve as respostas e o uso com a versão que atendeu', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: OK }]);
    const r = await new JevClient({ apiKey: () => 'chave-teste', fetch: fn }).ask({ narracao: 'Voltas ao balcão.' }, { tu: { type: 'noul', instructions: 'Trata por tu?' } });
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer chave-teste');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ model: 'jev-latest', state: { narracao: 'Voltas ao balcão.' }, questions: { tu: { type: 'noul', instructions: 'Trata por tu?' } } });
    expect(r.answers.tu).toEqual({ type: 'noul', noul: 0.94 });
    expect(r.usage).toEqual({ model: 'jev-1.14.0', inputTokens: 1200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('repete quando o serviço manda esperar (429, 529) e para no erro de validação, com a mensagem dele', async () => {
    const busy = fakeFetch([
      { status: 429, body: { error: 'devagar' } },
      { status: 529, body: 'cheio' },
      { status: 200, body: OK },
    ]);
    const r = await new JevClient({ apiKey: () => 'k', fetch: busy.fn, backoffMs: 1 }).ask('estado', {});
    expect(busy.calls).toHaveLength(3);
    expect(r.answers.tu).toBeDefined();
    const bad = fakeFetch([{ status: 422, body: { error: { message: 'pergunta malformada' } } }]);
    await expect(new JevClient({ apiKey: () => 'k', fetch: bad.fn }).ask('estado', {})).rejects.toThrow('Jev respondeu 422: pergunta malformada');
  });

  it('sem chave não chama nada e diz qual variável falta', async () => {
    const { fn, calls } = fakeFetch([{ status: 200, body: OK }]);
    const jev = new JevClient({ apiKey: () => undefined, fetch: fn });
    expect(jev.available).toBe(false);
    await expect(jev.ask('estado', {})).rejects.toThrow('TYPESAFE_API_KEY');
    expect(calls).toHaveLength(0);
  });

  it('sim e não só com confiança; a escolha só com confiança bastante', () => {
    expect(yesNo({ type: 'noul', noul: 0.85 })).toBe(true);
    expect(yesNo({ type: 'noul', noul: 0.15 })).toBe(false);
    expect(yesNo({ type: 'noul', noul: 0.6 })).toBeNull();
    expect(chosen({ type: 'choice', choice: 'L2', confidence: 0.8, probabilities: {} })).toBe('L2');
    expect(chosen({ type: 'choice', choice: 'G2', confidence: 0.12, probabilities: {} })).toBeNull();
  });

  it('toda versão do Jev cobra só a entrada, a US$ 0,042 por milhão', () => {
    expect(priceOf('jev-1.14.0')).toEqual({ input: 0.042, output: 0 });
    expect(usageCost({ model: 'jev-1.13.0', inputTokens: 1_000_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeCloseTo(0.042);
  });
});
