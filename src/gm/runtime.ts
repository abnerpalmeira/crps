import Anthropic from '@anthropic-ai/sdk';
import { WorkloadIdentityError } from '@anthropic-ai/sdk/lib/credentials/types';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameEngine } from '../engine/engine';
import { ClaudeProvider, DEFAULT_MODEL } from './claude';
import { GameMaster } from './gm';
import { modelChoice } from './models';
import { OfflineProvider } from './offline';
import type { Mode } from './pricing';
import type { Effort } from './provider';

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

export function loadEnv(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
}

function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = process.env[name];
  return value && EFFORTS.has(value) ? (value as Effort) : fallback;
}

export function isOffline(): boolean {
  return process.env.CRPS_PROVIDER === 'offline';
}

/** Mestre com o modelo escolhido na interface, o de CRPS_MODEL ou o padrão, nessa ordem. */
export function createGameMaster(opts: { model?: string } = {}): GameMaster {
  const model = opts.model || process.env.CRPS_MODEL || DEFAULT_MODEL;
  return new GameMaster({
    provider: isOffline()
      ? new OfflineProvider()
      : new ClaudeProvider({ model, fallback: modelChoice(model)?.fallback ?? true, verifierModel: process.env.CRPS_VERIFIER_MODEL }),
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
  if (err instanceof Anthropic.APIError) {
    const body = err.error as { error?: { message?: string } } | undefined;
    return `Erro da API do Claude (${err.status ?? '?'}): ${body?.error?.message ?? err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface Settings {
  model?: string;
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

  /** Preferências que sobrevivem ao reinício do servidor, como o modelo do mestre. */
  loadSettings(): Settings {
    const file = join(this.dir, 'settings.json');
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Settings) : {};
    } catch {
      return {};
    }
  }

  saveSettings(settings: Settings): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
  }

  /** Uma linha por turno em ledger.jsonl: quanto cada turno custou, por modelo. */
  appendLedger(entry: Record<string, unknown>): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, 'ledger.jsonl'), `${JSON.stringify(entry)}\n`);
  }
}

export function modeFromEnv(): Mode {
  return process.env.CRPS_MODE === 'release' ? 'release' : 'dev';
}

/** Quanto vale 1 crédito em US$ (padrão: US$ 0,01). */
export function creditUsdFromEnv(): number {
  const value = Number(process.env.CRPS_CREDIT_USD);
  return Number.isFinite(value) && value > 0 ? value : 0.01;
}
