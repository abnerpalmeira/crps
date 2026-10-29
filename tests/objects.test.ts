import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { objectType } from '../src/engine/objects';
import { runTool } from '../src/engine/tools';

const GALLERY = [
  '####QQ##QQ####',
  '#............#',
  '#.VVV....VVV.#',
  '#............#',
  '#.....PP.....#',
  '#............#',
  '#..NNN..NNN..#',
  '#............H',
  '##############',
];

function museum(): GameEngine {
  const e = GameEngine.create('teste', 4);
  e.createLocation({
    id: 'galeria',
    name: 'Galeria Norte',
    description: '',
    layout: GALLERY,
    legend: { Q: 'painting', V: 'vitrine', P: { label: 'pedestal duplo', like: 'pedestal', merge: true }, N: 'banco', H: 'hatch' },
  });
  return e;
}

describe('objetos como dado', () => {
  it('a legenda do local traz objetos da biblioteca, pelo id ou pelo nome', () => {
    const loc = museum().state.locations.galeria;
    const kinds = (k: string) => loc.fixtures.filter((f) => f.kind === k);
    expect(kinds('painting')).toHaveLength(2);
    expect(kinds('painting').every((f) => f.wall && f.facing === 'S')).toBe(true);
    expect(kinds('display_case')).toHaveLength(2);
    expect(kinds('display_case')[0]).toMatchObject({ w: 3, h: 1, label: 'vitrine' });
    expect(kinds('bench').every((f) => f.seat)).toBe(true);
    expect(loc.fixtures.map((f) => f.id)).toContain('galeria/vitrine-1');
  });

  it('tipo novo herda do parecido e vale para a campanha toda', () => {
    const e = museum();
    expect(e.state.objectTypes.pedestal_duplo).toMatchObject({ label: 'pedestal duplo', like: 'pedestal', surface: 1.05, merge: true });
    const loc = e.state.locations.galeria;
    expect(loc.fixtures.filter((f) => f.kind === 'pedestal_duplo')).toEqual([expect.objectContaining({ w: 2, h: 1 })]);
    expect(objectType(e.state, 'pedestal_duplo').label).toBe('pedestal duplo');
    // Num local novo, o mesmo nome reaproveita o tipo.
    e.createLocation({ id: 'reserva', name: 'Reserva técnica', description: '', layout: ['#####', '#...#', '#.P.D', '#...#', '#####'], legend: { P: 'pedestal duplo' } });
    expect(e.state.locations.reserva.fixtures.find((f) => f.kind === 'pedestal_duplo')).toBeTruthy();
  });

  it('cama e carro ficam no comprimento, de frente para a ponta mais livre', () => {
    const e = GameEngine.create('teste', 2);
    e.createLocation({
      id: 'quarto',
      name: 'Quarto',
      description: '',
      layout: ['#######', '#b....#', '#b....D', '#.....#', '#######'],
    });
    expect(e.state.locations.quarto.fixtures.find((f) => f.kind === 'bed')).toMatchObject({ w: 1, h: 2, facing: 'S' });
    e.createLocation({ id: 'rua', name: 'Rua', description: '', outdoor: true, layout: ['........', '.KKKK...', '.KKKK...', '........'], legend: { K: 'carro' } });
    expect(e.state.locations.rua.fixtures.find((f) => f.kind === 'car')).toMatchObject({ w: 4, h: 2, facing: 'E' });
  });

  it('escotilha é saída como a porta', () => {
    const loc = museum().state.locations.galeria;
    expect(Object.values(loc.exits)).toEqual([{ to: [], label: 'escotilha' }]);
    expect(loc.fixtures.find((f) => f.kind === 'hatch')).toMatchObject({ exit: 'door', wall: true });
  });

  it('o resumo explica os caracteres extras, e a tool recusa tipo desconhecido ou caractere da legenda fixa', () => {
    const e = museum();
    expect(compileBrief(e)).toMatch(/Legenda: .*'V' vitrine.*'P' pedestal duplo/);
    const unknown = runTool(e, 'create_location', { name: 'X', description: '', layout: ['#####', '#.U.D', '#####'], legend: { U: 'unicórnio de pelúcia' } });
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toMatch(/"unicórnio de pelúcia" não é um tipo de objeto conhecido/);
    const clash = runTool(e, 'create_location', { name: 'Y', description: '', layout: ['#####', '#.D.D', '#####'], legend: { D: 'vitrine' } });
    expect(clash.content).toMatch(/'D' já é porta na legenda fixa/);
  });

  it('save de antes dos tipos como dado: portas, elevadores e escadas viram saída pelo tipo', () => {
    const e = museum();
    e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: ['#####', '#...D', '#####'] });
    const raw = JSON.parse(e.toJSON());
    delete raw.objectTypes;
    for (const f of raw.locations.sala.fixtures) delete f.exit;
    const loaded = GameEngine.fromJSON(JSON.stringify(raw));
    expect(loaded.state.locations.sala.fixtures.find((f) => f.kind === 'door')?.exit).toBe('door');
    expect(loaded.state.objectTypes).toEqual({});
  });
});
