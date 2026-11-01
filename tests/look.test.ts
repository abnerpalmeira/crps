import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { ERA_DECOR, decorModel, locationLook } from '../src/engine/eras';
import { runTool } from '../src/engine/tools';
import { SYSTEM_PROMPT } from '../src/gm/prompts';
import { decorSpots } from '../src/client/dressing';

const ROOM = ['########', '#......#', '#......#', '#......#', '####D###'];

function world(era?: string): GameEngine {
  const e = GameEngine.create('teste', 4);
  runTool(e, 'define_ruleset', { name: 'R', attributes: [{ name: 'Vigor', description: '' }, { name: 'Astúcia', description: '' }], resources: [], ...(era ? { era } : {}) });
  return e;
}

const place = (e: GameEngine, input: Record<string, unknown>) => runTool(e, 'create_location', { id: 'sala', name: 'Sala', description: '', layout: ROOM, ...input });

describe('aparência dos lugares', () => {
  it('sem o mestre dizer, o lugar fechado tem as paredes, o chão e a decoração da época', () => {
    const e = world('medieval');
    expect(place(e, {}).ok).toBe(true);
    const loc = e.state.locations.sala;
    expect(loc.walls).toEqual({ material: 'pedra' });
    expect(loc.floor).toBe('stone');
    expect(loc.decor).toEqual(['tapecarias', 'luminarias']);
    expect(compileBrief(e)).toContain('Aparência: paredes de pedra, chão de pedra; nas paredes: tapeçarias e estandartes, tochas e luminárias de parede.');
  });

  it('o mestre escolhe material, cor e decoração, e parede nua é lista vazia', () => {
    const e = world('atual');
    place(e, { walls: 'azulejo', wall_color: '#AACCEE', decor: [], floor: 'tile' });
    expect(e.state.locations.sala.walls).toEqual({ material: 'azulejo', color: '#aaccee' });
    expect(compileBrief(e)).toContain('Aparência: paredes de azulejo (#aaccee), chão de ladrilho; paredes nuas.');
    const bad = runTool(e, 'create_location', { id: 'outra', name: 'Outra', description: '', layout: ROOM, wall_color: 'verde' });
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain('wall_color precisa ser uma cor #rrggbb');
  });

  it('área aberta não tem parede, e sem época tudo fica como era', () => {
    const e = world('medieval');
    runTool(e, 'create_location', { id: 'patio', name: 'Pátio', description: '', layout: ['.....', '.....', '.....'], outdoor: true });
    expect(e.state.locations.patio.walls).toBeUndefined();
    expect(locationLook(e.state.locations.patio).decor).toEqual([]);
    const old = world();
    place(old, {});
    expect(old.state.locations.sala.walls).toBeUndefined();
    expect(old.state.locations.sala.floor).toBe('wood');
    expect(compileBrief(old)).toContain('Aparência: paredes de reboco claro, chão de madeira; paredes nuas.');
  });

  it('update_location reforma só o que mudou, e o lugar de antes da aparência usa a da época', () => {
    const e = world('medieval');
    place(e, {});
    runTool(e, 'update_location', { location_id: 'sala', walls: 'tijolo', reason: 'reforma' });
    expect(e.state.locations.sala.walls).toEqual({ material: 'tijolo' });
    expect(e.state.locations.sala.decor).toEqual(['tapecarias', 'luminarias']);
    runTool(e, 'update_location', { location_id: 'sala', decor: [], reason: 'saquearam o castelo' });
    expect(e.state.locations.sala.decor).toEqual([]);
    // Lugar criado antes da aparência existir: só a época, e vale a dela.
    const loc = e.state.locations.sala;
    expect(locationLook({ ...loc, walls: undefined, decor: undefined })).toEqual({ walls: { material: 'pedra' }, decor: ['tapecarias', 'luminarias'] });
  });

  it('o mestre é orientado a vestir cada lugar e a narrar de acordo', () => {
    expect(SYSTEM_PROMPT).toContain('Dê a cada lugar fechado a aparência dele em create_location');
    expect(SYSTEM_PROMPT).toContain('O resumo mostra a aparência de cada lugar: narre de acordo com ela.');
  });

  it('decoração sem modelo na época vem da época mais próxima, de preferência a mais antiga', () => {
    expect(decorModel('quadros', 'medieval')).toBe(ERA_DECOR.medieval!.quadros);
    // Numa casa de hoje, o escudo com espadas é peça antiga na parede.
    expect(ERA_DECOR.atual!.armas).toBeUndefined();
    expect(decorModel('armas', 'atual')).toBe(ERA_DECOR.medieval!.armas);
    expect(decorModel('quadros', 'futuro')).toBe(ERA_DECOR.atual!.quadros);
  });

  it('a decoração vai na parede reta, um tile a cada três, e não atrás de móvel alto', () => {
    const e = world('medieval');
    place(e, { layout: ['##########', '#........#', '#........#', '#s.......#', '#........#', '####D#####'], legend: {}, decor: ['quadros', 'armas'] });
    const spots = decorSpots(e.state, e.state.locations.sala);
    expect(spots.length).toBeGreaterThan(3);
    for (const s of spots) {
      expect((s.x + s.y) % 3).toBe(0);
      // A parede dá para o cômodo de um lado só: nem canto, nem porta.
      expect(e.state.locations.sala.tiles[s.y][s.x]).toBe('#');
    }
    // A estante em (1,3) cobre a parede atrás dela, em (0,3).
    expect(spots.find((s) => s.x === 0 && s.y === 3)).toBeUndefined();
    expect(new Set(spots.map((s) => s.kind))).toEqual(new Set(['quadros', 'armas']));
    expect(decorSpots(e.state, { ...e.state.locations.sala, decor: [] })).toEqual([]);
  });
});
