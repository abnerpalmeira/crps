/**
 * Mulberry32. O estado mora no próprio mundo (`state.rng`), então um save
 * recarregado continua a mesma sequência e os testes são determinísticos.
 */
export function nextFloat(state: { rng: number }): number {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randInt(state: { rng: number }, min: number, max: number): number {
  return min + Math.floor(nextFloat(state) * (max - min + 1));
}

/** Sorteia `count` elementos distintos (Fisher-Yates parcial). */
export function pickMany<T>(state: { rng: number }, items: readonly T[], count: number): T[] {
  const pool = [...items];
  const n = Math.min(count, pool.length);
  for (let i = 0; i < n; i++) {
    const j = randInt(state, i, pool.length - 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}

export interface DiceExpr {
  count: number;
  sides: number;
  bonus: number;
}

export function parseDice(expr: string): DiceExpr | null {
  const m = /^\s*(\d{1,2})\s*d\s*(\d{1,3})\s*(?:([+-])\s*(\d{1,3}))?\s*$/i.exec(expr);
  if (!m) return null;
  const count = Number(m[1]);
  const sides = Number(m[2]);
  if (count < 1 || count > 20 || sides < 2) return null;
  const bonus = m[3] ? Number(m[4]) * (m[3] === '-' ? -1 : 1) : 0;
  return { count, sides, bonus };
}

export function rollDice(state: { rng: number }, count: number, sides: number): number[] {
  return Array.from({ length: count }, () => randInt(state, 1, sides));
}
