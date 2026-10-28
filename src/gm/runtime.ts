import Anthropic from '@anthropic-ai/sdk';
import { WorkloadIdentityError } from '@anthropic-ai/sdk/lib/credentials/types';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameEngine } from '../engine/engine';
import { ClaudeProvider } from './claude';
import { GameMaster } from './gm';
import { OfflineProvider } from './offline';
import type { Effort } from './provider';

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = process.env[name];
  return value && EFFORTS.has(value) ? (value as Effort) : fallback;
}

export function createGameMaster(): GameMaster {
  const offline = process.env.CRPS_PROVIDER === 'offline';
  return new GameMaster({
    provider: offline
      ? new OfflineProvider()
      : new ClaudeProvider({ model: process.env.CRPS_MODEL, verifierModel: process.env.CRPS_VERIFIER_MODEL }),
    effortSetup: effortFromEnv('CRPS_EFFORT_SETUP', 'medium'),
    effortTurn: effortFromEnv('CRPS_EFFORT_TURN', 'low'),
    verify: process.env.CRPS_VERIFY !== '0',
  });
}

/** Mensagem legível para erros da API e do restante do turno. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof WorkloadIdentityError) {
    return 'Credenciais da API do Claude inválidas, ausentes ou expiradas. Rode `ant auth login` ou defina ANTHROPIC_API_KEY no .env.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Limite de uso da API atingido. Espere um pouco e tente de novo.';
  if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a API do Claude.';
  if (err instanceof Anthropic.APIError) return `Erro da API do Claude (${err.status ?? '?'}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

/** Campanha atual em saves/current.json; campanhas anteriores são arquivadas ao lado. */
export class SaveStore {
  constructor(private readonly dir = process.env.CRPS_SAVES ?? 'saves') {}

  private get current(): string {
    return join(this.dir, 'current.json');
  }

  load(): GameEngine | null {
    return existsSync(this.current) ? GameEngine.fromJSON(readFileSync(this.current, 'utf8')) : null;
  }

  save(engine: GameEngine): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.current}.tmp`;
    writeFileSync(tmp, engine.toJSON());
    renameSync(tmp, this.current);
  }

  archive(): void {
    if (!existsSync(this.current)) return;
    const id = this.load()?.state.id ?? 'campanha';
    renameSync(this.current, join(this.dir, `${id}-${Date.now()}.json`));
  }
}
