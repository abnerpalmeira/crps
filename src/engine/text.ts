import type { Clock, Dir, Pos } from './types';

/** Minúsculas e sem acentos, para comparar nomes e buscar fatos. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

export function slugify(s: string, max = 32): string {
  const slug = fold(s)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
  return slug || 'x';
}

export function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function formatClock(c: Clock): string {
  return `Dia ${c.day}, ${hhmm(c.minutes)}`;
}

/** O que o jogador manda quando pede ao mestre para narrar, sem escrever: o tempo do turno acabou, ou ele quer seguir. */
export const NARRATE_INPUT = 'Peço ao mestre que narre o que acontece agora.';

/** Uma duração como se fala: "0,5 s", "45 s", "7 min 30 s", "2 h 5 min". */
export function formatDuration(seconds: number): string {
  if (seconds < 59.95) return `${String(Math.round(seconds * 10) / 10).replace('.', ',')} s`;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/** Minutos desde o início da campanha (dia 1, 00:00), para comparar horários. */
export function clockMinutes(c: Clock): number {
  return (c.day - 1) * 1440 + c.minutes;
}

export function addMinutes(c: Clock, minutes: number): Clock {
  const total = clockMinutes(c) + minutes;
  return { day: Math.floor(total / 1440) + 1, minutes: total % 1440 };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Número com sinal: +2, -1, 0. */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export const DIR_VEC: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const OPPOSITE: Record<Dir, Dir> = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Direção dominante de `from` para `to`; empates favorecem o eixo vertical. */
export function dirTowards(from: Pos, to: Pos): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'E' : 'W';
  if (dy === 0 && dx === 0) return 'S';
  return dy > 0 ? 'S' : 'N';
}

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Distância de Chebyshev entre um ponto e o retângulo mais próximo dele. */
export function distanceToRect(p: Pos, r: { x: number; y: number; w: number; h: number }): number {
  const cx = Math.min(Math.max(p.x, r.x), r.x + r.w - 1);
  const cy = Math.min(Math.max(p.y, r.y), r.y + r.h - 1);
  return chebyshev(p, { x: cx, y: cy });
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
