import type { Fixture, FloorStyle } from './types';

/**
 * Layouts prontos para lugares comuns: o mestre escolhe o tipo e o motor desenha com a função de
 * cada coisa no lugar certo (a portaria junto da entrada, elevadores e escada no fundo). Para
 * lugares únicos, o mestre continua desenhando o ASCII.
 */
export type TemplateName = 'saguao' | 'corredor';

export interface TemplateOptions {
  /** Andar do corredor: numera os apartamentos (11 → Apto 1101, 1102…). */
  floor?: number;
  /** Comprimento do corredor ou largura do saguão, em tiles. */
  width?: number;
}

export interface TemplateLayout {
  rows: string[];
  floor: FloorStyle;
  /** Nome de cada saída, pela ordem de leitura do layout (de cima para baixo, da esquerda para a direita). */
  label(fixture: Fixture, index: number, exits: Fixture[]): string;
}

export const TEMPLATES: Record<TemplateName, string> = {
  saguao: 'saguão de prédio: entrada dupla para a rua, portaria com balcão e cadeira junto da entrada, dois elevadores e a escada no fundo, estante, sofá e plantas',
  corredor: 'corredor de um andar: portas dos apartamentos numeradas, elevador numa ponta e escada na outra',
};

function grid(w: number, h: number): string[][] {
  return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.')));
}

function lobby(width: number, mirror: boolean): TemplateLayout {
  const w = Math.max(14, Math.min(22, width));
  const h = 11;
  const g = grid(w, h);
  const door = Math.floor(w / 2) - 1;
  g[h - 1][door] = g[h - 1][door + 1] = 'D';
  // Fundo: dois elevadores e a escada no canto.
  for (const x of [door - 3, door - 2, door + 2, door + 3]) g[0][x] = 'E';
  g[0][w - 3] = 'Z';
  // Portaria: balcão de frente para a entrada, com a cadeira do porteiro atrás.
  for (const x of [2, 3, 4]) g[h - 4][x] = 'C';
  g[h - 5][3] = 'c';
  // Estante na parede, sofá encostado na outra com uma mesinha na frente.
  g[2][1] = g[3][1] = 's';
  for (const y of [4, 5, 6]) g[y][w - 2] = 'S';
  g[5][w - 4] = 't';
  for (const [x, y] of [[w - 2, 2], [door - 2, h - 2], [door + 3, h - 2], [1, h - 3]]) g[y][x] = 'p';
  const rows = g.map((r) => (mirror ? [...r].reverse() : r).join(''));
  return {
    rows,
    floor: 'tile',
    label: (f, _i, exits) => {
      if (f.kind === 'door') return 'Saída para a rua';
      if (f.kind === 'stairs') return 'Escada';
      const elevators = exits.filter((e) => e.kind === 'elevator');
      return elevators.length > 1 ? `Elevador ${'AB'[elevators.indexOf(f)] ?? elevators.indexOf(f) + 1}` : 'Elevador';
    },
  };
}

function hallway(width: number, floor: number, mirror: boolean): TemplateLayout {
  const w = Math.max(12, Math.min(30, width));
  const h = 5;
  const g = grid(w, h);
  // Elevador numa ponta, escada na outra, portas dos apartamentos dos dois lados.
  g[1][0] = g[2][0] = 'E';
  g[2][w - 1] = 'Z';
  for (let x = 3; x < w - 2; x += 5) g[0][x] = 'D';
  for (let x = 5; x < w - 2; x += 5) g[h - 1][x] = 'D';
  // Plantas longe das portas: nenhuma porta fica acima de w - 2 nem abaixo de x = 2.
  g[3][2] = 'p';
  g[1][w - 2] = 'p';
  const rows = g.map((r) => (mirror ? [...r].reverse() : r).join(''));
  return {
    rows,
    floor: 'carpet',
    label: (f, _i, exits) => {
      if (f.kind === 'elevator') return 'Elevador';
      if (f.kind === 'stairs') return 'Escada';
      const doors = exits.filter((e) => e.kind === 'door');
      return `Apto ${floor}${String(doors.indexOf(f) + 1).padStart(2, '0')}`;
    },
  };
}

export function buildTemplate(name: TemplateName, opts: TemplateOptions, random: () => number): TemplateLayout {
  const mirror = random() < 0.5;
  if (name === 'saguao') return lobby(opts.width ?? 16, mirror);
  return hallway(opts.width ?? 18, opts.floor ?? 1, mirror);
}
