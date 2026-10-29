import { describe, expect, it } from 'vitest';
import { randomPremise } from '../src/client/premises';

/** Gerador com semente, para o teste ser reproduzível. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('premissa sorteada', () => {
  it('monta gênero, quem o jogador é e um gancho, em primeira pessoa', () => {
    const premise = randomPremise(seeded(7));
    expect(premise).toMatch(/^(Um|Uma) .+ em que eu sou .+ e .+\.$/);
  });

  it('varia de um sorteio para o outro e não repete a anterior', () => {
    const random = seeded(42);
    const rolls = Array.from({ length: 40 }, () => randomPremise(random));
    expect(new Set(rolls).size).toBeGreaterThan(35);
    const first = randomPremise(seeded(1));
    expect(randomPremise(seeded(1), first)).not.toBe(first);
  });
});
