import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { ClaudeProvider } from '../src/gm/claude';
import { MODEL_CHOICES, modelChoice } from '../src/gm/models';
import { priceOf } from '../src/gm/pricing';
import { SaveStore } from '../src/gm/runtime';

/** Cliente falso: guarda os parâmetros de cada chamada e responde um texto curto. */
function fakeClient(calls: Record<string, unknown>[]): Anthropic {
  return {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push(params);
          return {
            on() {
              return this;
            },
            async finalMessage() {
              return {
                model: params.model,
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                stop_details: null,
                usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
              };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
}

describe('modelos do mestre', () => {
  it('todo modelo do seletor tem preço', () => {
    for (const m of MODEL_CHOICES) expect(priceOf(m.id), m.id).not.toBeNull();
    expect(priceOf('claude-fable-5-1')).toEqual({ input: 10, output: 50 });
  });

  it('pede fallback no servidor só a quem tem (o Haiku 5.5 não tem)', async () => {
    for (const id of ['claude-opus-5-5', 'claude-haiku-5-5']) {
      const calls: Record<string, unknown>[] = [];
      const provider = new ClaudeProvider({ model: id, fallback: modelChoice(id)!.fallback, client: fakeClient(calls) });
      await provider.startSession({ system: 'regras', tools: [], userMessage: 'oi', effort: 'low' }).step();
      expect(calls[0]).toMatchObject({ model: id, output_config: { effort: 'low' } });
      if (id === 'claude-haiku-5-5') {
        expect(calls[0]).not.toHaveProperty('fallbacks');
        expect(calls[0]).not.toHaveProperty('betas');
      } else expect(calls[0]).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    }
  });

  it('a escolha sobrevive ao reinício do servidor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crps-'));
    try {
      const store = new SaveStore(dir);
      expect(store.loadSettings()).toEqual({});
      store.saveSettings({ model: 'claude-sonnet-5-5' });
      expect(new SaveStore(dir).loadSettings()).toEqual({ model: 'claude-sonnet-5-5' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
