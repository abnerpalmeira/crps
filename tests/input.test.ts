import { describe, expect, it } from 'vitest';
import { compileBrief } from '../src/engine/brief';
import { GameEngine } from '../src/engine/engine';
import { describeInput, hasMarks, parsePlayerInput } from '../src/engine/input';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';
import { GameMaster } from '../src/gm/gm';
import { OfflineProvider } from '../src/gm/offline';
import type { ModelProvider, ModelSession, SessionOptions, Verdict } from '../src/gm/provider';

const kinds = (input: string) => parsePlayerInput(input).map((s) => [s.kind, s.text, ...(s.target ? [s.target] : [])]);

describe('marcas na ação do jogador', () => {
  it('aspas falam, asteriscos agem, parênteses pensam e @Nome sussurra', () => {
    expect(kinds('"Bom dia, turma." *abro a janela* (estão todos cansados) @Mei "me encontra depois"')).toEqual([
      ['fala', 'Bom dia, turma.'],
      ['acao', 'abro a janela'],
      ['pensamento', 'estão todos cansados'],
      ['sussurro', 'me encontra depois', 'Mei'],
    ]);
  });

  it('aceita aspas curvas, travessão de diálogo e @Nome: com dois-pontos', () => {
    expect(kinds('“Silêncio!”')).toEqual([['fala', 'Silêncio!']]);
    expect(kinds('— Bom dia, turma.\n- Sentem-se.')).toEqual([
      ['fala', 'Bom dia, turma.'],
      ['fala', 'Sentem-se.'],
    ]);
    expect(kinds('@mei: “vem cá”')).toEqual([['sussurro', 'vem cá', 'mei']]);
  });

  it('texto sem marca é ação livre; palavras de ligação somem', () => {
    expect(parsePlayerInput('Vou até a Mei.')).toEqual([{ kind: 'acao', text: 'Vou até a Mei.', free: true }]);
    expect(kinds('"Oi" digo, e *aceno*')).toEqual([
      ['fala', 'Oi'],
      ['acao', 'aceno'],
    ]);
    expect(kinds('Abro a porta e digo "Entrem"')).toEqual([
      ['acao', 'Abro a porta e digo'],
      ['fala', 'Entrem'],
    ]);
  });

  it('marca sem fechamento vai até o fim da linha', () => {
    expect(kinds('"Esperem, eu')).toEqual([['fala', 'Esperem, eu']]);
    expect(kinds('(será que ela sabe')).toEqual([['pensamento', 'será que ela sabe']]);
  });

  it('sem nenhuma marca, a ação segue livre como antes', () => {
    expect(hasMarks(parsePlayerInput('Vou até a Mei e pergunto se ela está bem.'))).toBe(false);
    expect(hasMarks(parsePlayerInput('*acena*'))).toBe(true);
  });

  it('o mestre recebe cada parte com o nome de quem recebe o sussurro', () => {
    const e = GameEngine.create('teste', 3);
    e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
    e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { x: 6, y: 1 } });
    e.createCharacter({ name: 'Mei Kato', role: 'aluna', appearance: '', position: { x: 7, y: 1 } });
    expect(describeInput(e.state, parsePlayerInput('"Oi." (cansado) @Mei "depois" @Zeca "ei" olho em volta'))).toEqual([
      '- fala (em voz alta): "Oi."',
      '- pensamento (só na cabeça dele): cansado',
      '- sussurro para Mei Kato [mei]: "depois"',
      '- sussurro para "Zeca" (ninguém com esse nome aqui): "ei"',
      '- ação: olho em volta',
    ]);
  });
});

/** Mestre falso que só narra e guarda a mensagem do turno e o que o verificador recebeu. */
class Recorder implements ModelProvider {
  readonly label = 'recorder';
  turnMessages: string[] = [];
  verified: string[] = [];
  startSession(opts: SessionOptions): ModelSession {
    this.turnMessages.push(opts.userMessage);
    return {
      step: async () => ({ text: 'A turma espera.', toolCalls: [], stop: 'end_turn' as const }),
      addToolResults() {},
      addUserText() {},
    };
  }
  async verify(prompt: string): Promise<{ verdict: Verdict }> {
    this.verified.push(prompt);
    return { verdict: { consistent: true, issues: [] } };
  }
}

describe('o mestre e a ação marcada', () => {
  function room(): GameEngine {
    const e = GameEngine.create('teste', 3);
    e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
    e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { x: 6, y: 1 } });
    e.createCharacter({ name: 'Mei Kato', role: 'aluna', appearance: '', position: { x: 7, y: 1 } });
    return e;
  }

  it('recebe as partes marcadas; o pensamento vira estado e ninguém percebe', async () => {
    const e = room();
    const provider = new Recorder();
    await new GameMaster({ provider }).play(e, '"Bom dia." (ela parece cansada) @Mei "fica depois da aula"', () => {});
    expect(provider.turnMessages[0]).toContain(
      'Como o jogador marcou:\n- fala (em voz alta): "Bom dia."\n- pensamento (só na cabeça dele): ela parece cansada\n- sussurro para Mei Kato [mei]: "fica depois da aula"',
    );
    expect(provider.verified[0]).toContain('- pensamento (só na cabeça dele): ela parece cansada');
    expect(e.state.characters.kenji.thoughts).toBe('ela parece cansada');
    expect(compileBrief(e)).toContain('Pensamento dele agora: "ela parece cansada". Ninguém percebe; nenhum NPC reage a isso.');
  });

  it('quem lê mentes percebe o pensamento do jogador; sem pensamento no turno, ele se apaga', async () => {
    const e = room();
    e.extendRuleset({ reason: 'poder', perks: [{ name: 'Telepatia', description: '', grants: [{ kind: 'sense', channel: 'mente', bonus: 5 }] }] });
    e.updateCharacter({ character_id: 'mei', perks_add: ['telepatia'] });
    const gm = new GameMaster({ provider: new Recorder() });
    await gm.play(e, '(será que ela sabe?)', () => {});
    expect(compileBrief(e)).toContain('Pensamento dele agora: "será que ela sabe?". Percebem: Mei Kato.');
    await gm.play(e, 'Olho pela janela.', () => {});
    expect(e.state.characters.kenji.thoughts).toBeNull();
  });

  it('sem marcas, a ação vai como sempre foi', async () => {
    const provider = new Recorder();
    await new GameMaster({ provider }).play(room(), 'Vou até a Mei.', () => {});
    expect(provider.turnMessages[0]).not.toContain('Como o jogador marcou');
  });

  it('na demo, o sussurro marcado leva o professor até a pessoa e só ela ouve', async () => {
    const gm = new GameMaster({ provider: new OfflineProvider() });
    const engine = GameEngine.create('demo', 3);
    await gm.setup(engine, () => {});
    const failed: string[] = [];
    await gm.play(engine, '@Yuki "me entrega o trabalho no intervalo"', (ev) => {
      if (ev.type === 'tool' && !ev.ok) failed.push(ev.summary);
    });
    expect(failed).toEqual([]);
    const fact = engine.state.facts.find((f) => f.text.includes('me entrega o trabalho'))!;
    expect(fact.knownBy).toEqual(expect.arrayContaining(['voce', 'yuki']));
    expect(fact.knownBy).toHaveLength(2);
  }, 20_000);
});
