import { describe, expect, it } from 'vitest';
import { GameEngine } from '../src/engine/engine';
import { parseSpeechLine } from '../src/engine/frames';
import { analyzeSpeech, playerNarration } from '../src/engine/speech';
import { EXAMPLE_CLASSROOM } from '../src/engine/tools';
import { GameMaster, type GmEvent } from '../src/gm/gm';
import type { ModelProvider, ModelSession, SessionOptions, StepHandlers, StepResult, Verdict } from '../src/gm/provider';

/**
 * Professor (jogador) perto do quadro em (6,1); Haruto (2,4) e Yuki (4,4) em carteiras vizinhas,
 * a 2 tiles; Mei no fundo (10,8), a 8 tiles do Haruto e a 7 do professor.
 */
function room(): GameEngine {
  const e = GameEngine.create('teste', 3);
  e.createLocation({ id: 'sala', name: 'Sala', description: '', layout: EXAMPLE_CLASSROOM });
  e.createCharacter({ name: 'Kenji Tanaka', role: 'professor', appearance: '', is_player: true, position: { x: 6, y: 1 } });
  e.createCharacter({ name: 'Haruto Mori', role: 'aluno', appearance: '', position: { seat: 'sala/carteira-1' } });
  e.createCharacter({ name: 'Yuki Sato', role: 'aluna', appearance: '', position: { seat: 'sala/carteira-2' } });
  e.createCharacter({ name: 'Mei Kato', role: 'aluna', appearance: '', position: { seat: 'sala/carteira-15' } });
  e.introduce({ group: ['kenji', 'haruto', 'yuki', 'mei'] });
  return e;
}

function givePerk(e: GameEngine, grant: { kind: 'sense'; channel: string; multiplier?: number; bonus?: number }) {
  e.extendRuleset({ reason: 'teste', perks: [{ id: 'sentido', name: 'Sentido', description: '', grants: [grant] }] });
  e.updateCharacter({ character_id: 'kenji', perks_add: ['sentido'] });
}

describe('falas com alcance', () => {
  it('recusa cochicho com quem está do outro lado da sala', () => {
    const { issues } = analyzeSpeech(room().state, '@haruto[cochicho>mei]: Ele tá de bom humor hoje.');
    expect(issues).toEqual([expect.stringContaining('Haruto Mori cochicha para Mei Kato a 8 tiles de distância, e "cochicho" exige até 2')]);
  });

  it('cochicho ao alcance: só o alvo ouve, e a fala é restrita', () => {
    const { issues, lines } = analyzeSpeech(room().state, '@haruto[cochicho>yuki]: Ele tá de bom humor hoje.');
    expect(issues).toEqual([]);
    expect(lines[0]).toMatchObject({ speakerId: 'haruto', targetId: 'yuki', hearers: ['haruto', 'yuki'], restricted: true });
  });

  it('voz normal cobre a sala; id ou modo inexistente viram correção', () => {
    const e = room();
    expect(analyzeSpeech(e.state, '@mei: Bom dia!').lines[0]).toMatchObject({ restricted: false });
    expect(analyzeSpeech(e.state, '@fulano: oi').issues[0]).toMatch(/id que não existe/);
    expect(analyzeSpeech(e.state, '@haruto[berro]: oi').issues[0]).toMatch(/modo "berro", que não existe \(modos: fala, cochicho, grito\)/);
  });

  it('o jogador vê só o gesto do cochicho que não ouviu', () => {
    const text = 'Haruto se inclina.\n@haruto[cochicho>yuki]: Ele tá de bom humor hoje.';
    expect(playerNarration(room().state, text)).toBe('Haruto se inclina.\n@haruto[cochicho>yuki|oculto]: cochicha algo para Yuki');
  });

  it('perks de sentido liberam o conteúdo, e o jogador vê qual perk: super audição, leitura labial, telepatia', () => {
    const text = '@haruto[cochicho>yuki]: Ele tá de bom humor hoje.';
    for (const grant of [
      { kind: 'sense' as const, channel: 'som', multiplier: 8 },
      { kind: 'sense' as const, channel: 'labios', multiplier: 2 },
      { kind: 'sense' as const, channel: 'mente', bonus: 5 },
    ]) {
      const e = room();
      givePerk(e, grant);
      const shown = playerNarration(e.state, text);
      expect(shown).toBe('@haruto[cochicho>yuki|via Sentido]: Ele tá de bom humor hoje.');
      expect(parseSpeechLine(shown)).toMatchObject({ mode: 'cochicho', targetId: 'yuki', hidden: false, via: 'Sentido', text: 'Ele tá de bom humor hoje.' });
    }
    // Fala normal que ele já ouviria sem perk não ganha marca.
    const e = room();
    givePerk(e, { kind: 'sense', channel: 'som', multiplier: 8 });
    expect(playerNarration(e.state, '@mei: Bom dia!')).toBe('@mei: Bom dia!');
    for (const grant of [
      { kind: 'sense' as const, channel: 'som', multiplier: 4 },
      { kind: 'sense' as const, channel: 'mente', bonus: 3 },
    ]) {
      const e = room();
      givePerk(e, grant);
      expect(playerNarration(e.state, text)).toContain('|oculto');
    }
  });

  it('ação com alvo também tem alcance', () => {
    const e = room();
    expect(() =>
      e.skillCheck({ character_id: 'haruto', attribute: 'corpo', difficulty: 'normal', reason: 'empurrar', target_id: 'mei', reach: 'corpo_a_corpo' }),
    ).toThrow(/Mei Kato está a 8 tiles de Haruto Mori, e "corpo_a_corpo" alcança 1/);
    const thrown = e.skillCheck({ character_id: 'haruto', attribute: 'corpo', difficulty: 'normal', reason: 'jogar borracha', target_id: 'yuki', reach: 'arremesso' });
    expect(thrown.against).toEqual({ id: 'yuki', name: 'Yuki Sato', distance: 2, reach: 'arremesso', sight: 'nitido' });
    expect(() => e.skillCheck({ character_id: 'haruto', attribute: 'corpo', difficulty: 'normal', reason: 'x', target_id: 'yuki', reach: 'laser' })).toThrow(
      /Alcance "laser" não existe/,
    );
  });
});

/** Provedor roteirizado: cada sessão (turno) consome uma lista de respostas do "modelo". */
class Script implements ModelProvider {
  readonly label = 'script';
  sessions: { userTexts: string[] }[] = [];
  constructor(private readonly steps: StepResult[]) {}
  startSession(_opts: SessionOptions): ModelSession {
    const steps = this.steps;
    const record = { userTexts: [] as string[] };
    this.sessions.push(record);
    return {
      async step(handlers?: StepHandlers) {
        const next = steps.shift();
        if (!next) throw new Error('roteiro acabou');
        if (next.text) handlers?.onText?.(next.text);
        return next;
      },
      addToolResults() {},
      addUserText: (text: string) => record.userTexts.push(text),
    };
  }
  async verify(): Promise<{ verdict: Verdict }> {
    return { verdict: { consistent: true, issues: [] } };
  }
}

describe('mestre e cochichos', () => {
  it('pede correção do cochicho à distância e guarda o conteúdo só para quem ouviu', async () => {
    const e = room();
    const provider = new Script([
      { text: '@haruto[cochicho>mei]: Ele tá de bom humor hoje.', toolCalls: [], stop: 'end_turn' },
      { text: '', toolCalls: [{ id: 't1', name: 'move_character', input: { character_id: 'haruto', to: { near: 'mei' } } }], stop: 'tool_use' },
      { text: 'Haruto vai até a Mei.\n@haruto[cochicho>mei]: Ele tá de bom humor hoje.', toolCalls: [], stop: 'end_turn' },
    ]);
    const events: GmEvent[] = [];
    await new GameMaster({ provider }).play(e, 'Observo a turma.', (ev) => events.push(ev));

    expect(provider.sessions[0].userTexts[0]).toContain('"cochicho" exige até 2');
    const narration = events.filter((ev) => ev.type === 'narration').at(-1) as Extract<GmEvent, { type: 'narration' }>;
    expect(narration.text).toBe('Haruto vai até a Mei.\n@haruto[cochicho>mei|oculto]: cochicha algo para Mei');
    // Nem a primeira versão, a do cochicho à distância, chega ao jogador.
    expect(JSON.stringify(events.filter((ev) => ev.type === 'narration' || ev.type === 'status'))).not.toContain('bom humor');

    const fact = e.state.facts.find((f) => f.text.includes('bom humor'))!;
    expect(fact.knownBy).toEqual(expect.arrayContaining(['haruto', 'mei']));
    expect(fact.knownBy).not.toContain('kenji');
    expect(e.state.log.at(-1)!.text).toContain('bom humor');
    expect(e.snapshot().log.at(-1)!.text).not.toContain('bom humor');
  });
});
