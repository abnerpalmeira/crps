import { describe, expect, it } from 'vitest';
import { CostMeter, costEvent, toCredits, usageCost } from '../src/gm/pricing';

/** O primeiro turno real que jogamos: 4 chamadas ao Opus (com correção do verificador) e 1 ao Haiku. */
const MEASURED_TURN = [
  { model: 'claude-opus-5-5', inputTokens: 4, outputTokens: 317, cacheReadTokens: 7276, cacheWriteTokens: 2733 },
  { model: 'claude-opus-5-5', inputTokens: 2, outputTokens: 633, cacheReadTokens: 10009, cacheWriteTokens: 538 },
  { model: 'claude-haiku-5-5', inputTokens: 3519, outputTokens: 731, cacheReadTokens: 0, cacheWriteTokens: 0 },
  { model: 'claude-opus-5-5', inputTokens: 4, outputTokens: 83, cacheReadTokens: 10547, cacheWriteTokens: 790 },
  { model: 'claude-opus-5-5', inputTokens: 2, outputTokens: 591, cacheReadTokens: 11337, cacheWriteTokens: 149 },
];

function measured() {
  const meter = new CostMeter();
  for (const u of MEASURED_TURN) meter.add(u);
  return meter.summary();
}

describe('custo do turno', () => {
  it('soma por modelo o turno real medido (≈ US$ 0,062)', () => {
    const cost = measured();
    expect(cost.requests).toBe(5);
    expect(cost.byModel['claude-opus-5-5']).toMatchObject({ requests: 4, outputTokens: 1624, cacheReadTokens: 39169, cacheWriteTokens: 4210 });
    expect(cost.usd).toBeCloseTo(0.0621, 3);
    expect(cost.unpriced).toEqual([]);
  });

  it('converte em créditos sempre arredondando para cima', () => {
    expect(toCredits(0, 0.01)).toBe(0);
    expect(toCredits(0.05, 0.01)).toBe(5);
    expect(toCredits(measured().usd, 0.01)).toBe(7);
    expect(toCredits(measured().usd, 0.05)).toBe(2);
  });

  it('no release o evento leva só créditos; no dev, US$ e o detalhe por modelo', () => {
    const cost = measured();
    expect(costEvent(cost, { mode: 'release', creditUsd: 0.01, turn: 1 })).toEqual({ type: 'cost', turn: 1, credits: 7 });
    const dev = costEvent(cost, { mode: 'dev', creditUsd: 0.01, turn: 1 });
    expect(dev.usd).toBeCloseTo(0.0621, 3);
    expect(dev.detail).toContain('claude-opus-5-5 ×4');
    expect(dev.detail).toContain('claude-haiku-5-5 ×1');
  });

  it('modelo sem preço fica fora do total e é avisado', () => {
    const meter = new CostMeter();
    meter.add({ model: 'modelo-novo', inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(usageCost({ model: 'modelo-novo', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
    expect(meter.summary()).toMatchObject({ usd: 0, unpriced: ['modelo-novo'] });
  });
});
