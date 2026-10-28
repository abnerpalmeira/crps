import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { buildLocation } from '../src/engine/layout';
import { GameMaster, type GmEvent } from '../src/gm/gm';
import { DEMO_CLASSROOM, OfflineProvider } from '../src/gm/offline';

describe('OfflineProvider', () => {
  it('usa um layout de demonstração válido', () => {
    const result = buildLocation({ id: 'sala_2b', name: 'Sala 2-B', description: '', layout: DEMO_CLASSROOM });
    expect(result.ok ? result.warnings : result.errors).toEqual([]);
  });

  it('monta a sala e joga um turno sem modelo, sem erros de tool', async () => {
    const gm = new GameMaster({ provider: new OfflineProvider() });
    const engine = GameEngine.create('demo', 3);
    const events: GmEvent[] = [];
    await gm.setup(engine, (e) => events.push(e));
    await gm.play(engine, 'Escrevo no quadro "Período Edo" e faço a chamada.', (e) => events.push(e));

    const failed = events.filter((e) => e.type === 'tool' && !e.ok);
    expect(failed).toEqual([]);
    expect(Object.keys(engine.state.characters)).toHaveLength(9);
    expect(engine.findFixture('sala_2b/quadro-1').text).toBe('Período Edo');
    expect(engine.state.clock.minutes).toBe(8 * 60);
  });
});
