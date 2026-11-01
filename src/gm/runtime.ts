import Anthropic from '@anthropic-ai/sdk';
import { WorkloadIdentityError } from '@anthropic-ai/sdk/lib/credentials/types';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { ModelCatalog, eraLooks, modelCatalog, setBaseLooks, setModelCatalog, type RepertoireItem } from '../engine/catalog';
import { GameEngine } from '../engine/engine';
import { JevChecker, LlmChecker, ShadowChecker, type Checker } from './checker';
import { ClaudeProvider, DEFAULT_MODEL } from './claude';
import { GameMaster } from './gm';
import { JEV_KEY_ENV, JevClient } from './jev';
import { SERVICES, modelChoice, serviceOf } from './models';
import { OpenAICompatibleProvider, ProviderHttpError } from './openai';
import { systemPrompt, type LookOption } from './prompts';
import { OfflineProvider } from './offline';
import type { Mode } from './pricing';
import type { Effort, ModelProvider } from './provider';

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max']);

/** Chaves de serviço que vieram do .env, e não do ambiente: essas o .env pode trocar. */
const fileKeys = new Set<string>();

/** Lê o .env sem passar por cima do ambiente. */
export function loadEnv(file = '.env'): void {
  reloadServiceKeys(file);
  if (existsSync(file)) process.loadEnvFile(file);
}

/**
 * Relê no .env só as chaves dos serviços (VENICE_API_KEY, a do Jev…); o servidor chama a cada pedido
 * de estado, então a chave posta ou trocada com ele no ar já vale. A que veio do ambiente continua.
 */
export function reloadServiceKeys(file = '.env'): void {
  if (!existsSync(file)) return;
  const vars = parseEnv(readFileSync(file, 'utf8')) as Record<string, string | undefined>;
  for (const keyEnv of [...Object.values(SERVICES).map((s) => s.keyEnv), JEV_KEY_ENV]) {
    const value = vars[keyEnv];
    if (value === undefined || (process.env[keyEnv] !== undefined && !fileKeys.has(keyEnv))) continue;
    process.env[keyEnv] = value;
    fileKeys.add(keyEnv);
  }
}

function effortFromEnv(name: string, fallback: Effort): Effort {
  const value = process.env[name];
  return value && EFFORTS.has(value) ? (value as Effort) : fallback;
}

export function isOffline(): boolean {
  return process.env.CRPS_PROVIDER === 'offline';
}

/**
 * Catálogo de modelos 3D (o repertório Synty descrito olhando), se ele estiver nesta máquina: o
 * mestre busca nele com search_models, e o servidor converte o que o 3D pedir.
 */
export function loadModelCatalog(path = join('assets', 'synty', 'repertorio.json')): ModelCatalog | null {
  try {
    const catalog = new ModelCatalog((JSON.parse(readFileSync(path, 'utf8')) as { items: RepertoireItem[] }).items);
    setModelCatalog(catalog);
    return catalog;
  } catch {
    return null;
  }
}

/** Visuais de hoje que vêm convertidos com o jogo (public/models), se houver, para o mestre escolher. */
export function lookOptions(path = join('public', 'models', 'catalog.json')): LookOption[] {
  try {
    const catalog = JSON.parse(readFileSync(path, 'utf8')) as { characters?: Record<string, { figure: string; look?: string }> };
    return Object.entries(catalog.characters ?? {}).flatMap(([id, c]) => (c.look ? [{ id, figure: c.figure, look: c.look }] : []));
  } catch {
    return [];
  }
}

/**
 * O provedor de um modelo: o Claude, ou um serviço compatível com a OpenAI pelo prefixo do id
 * ("venice/…", models.ts). O verificador é do mesmo modelo, salvo CRPS_VERIFIER_MODEL; se ele for
 * de outro serviço, o mestre fala com um e o juiz com o outro.
 */
export function providerFor(model: string, verifierModel?: string): ModelProvider {
  const same = !verifierModel || (serviceOf(verifierModel)?.id ?? 'claude') === (serviceOf(model)?.id ?? 'claude');
  const main = singleProvider(model, same ? verifierModel : undefined);
  if (same) return main;
  const judge = singleProvider(verifierModel!, verifierModel);
  return { label: main.label, startSession: (opts) => main.startSession(opts), verify: (prompt) => judge.verify(prompt) };
}

function singleProvider(model: string, verifierModel: string | undefined): ModelProvider {
  const s = serviceOf(model);
  if (!s) return new ClaudeProvider({ model, fallback: modelChoice(model)?.fallback ?? true, verifierModel });
  return new OpenAICompatibleProvider({
    service: s.id,
    label: s.service.label,
    // Outra URL do mesmo serviço (um proxy, uma região): VENICE_BASE_URL.
    baseUrl: process.env[`${s.id.toUpperCase()}_BASE_URL`] ?? s.service.baseUrl,
    apiKey: () => process.env[s.service.keyEnv],
    keyEnv: s.service.keyEnv,
    model: s.model,
    verifierModel: verifierModel ? serviceOf(verifierModel)?.model : undefined,
    extra: s.service.extra,
  });
}

/** Mestre com o modelo escolhido na interface, o de CRPS_MODEL ou o padrão, nessa ordem. */
export function createGameMaster(opts: { model?: string } = {}): GameMaster {
  const model = opts.model || process.env.CRPS_MODEL || DEFAULT_MODEL;
  // Visuais: os de hoje que vêm com o jogo e os do catálogo para as outras épocas. Sem nenhum
  // (a demo offline, uma máquina sem os modelos), o prompt fica sem a seção.
  const base = isOffline() ? [] : lookOptions();
  setBaseLooks(base);
  const looks = base.length > 0 || (!isOffline() && modelCatalog() !== null);
  const provider = isOffline() ? new OfflineProvider() : providerFor(model, process.env.CRPS_VERIFIER_MODEL);
  return new GameMaster({
    provider,
    effortSetup: effortFromEnv('CRPS_EFFORT_SETUP', 'medium'),
    effortTurn: effortFromEnv('CRPS_EFFORT_TURN', 'low'),
    verify: process.env.CRPS_VERIFY !== '0',
    // Na demo offline quem confere é o roteiro, sem rede.
    checker: isOffline() ? undefined : checkerFor(provider),
    system: (world, setup) => systemPrompt(!looks ? null : setup ? [] : eraLooks(world.era)),
  });
}

/**
 * Quem confere a narração (CRPS_VERIFY): "jev" é o código e o Jev, com o modelo de reserva; "llm", só
 * o modelo; "ambos" roda os dois, o jogo segue o modelo e os dois vereditos vão para
 * conferencias.jsonl, para comparar. Sem valor, é "jev", que sem a chave confere pelo modelo.
 */
export function checkerFor(provider: ModelProvider, mode = process.env.CRPS_VERIFY, dir = process.env.CRPS_SAVES ?? 'saves'): Checker {
  const llm = new LlmChecker(provider);
  if (mode === 'llm') return llm;
  if (mode === 'ambos') {
    return new ShadowChecker(llm, new JevChecker(new JevClient()), (entry) => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'conferencias.jsonl'), `${JSON.stringify(entry)}\n`);
    });
  }
  return new JevChecker(new JevClient(), llm);
}

/** Mensagem legível para erros da API e do restante do turno. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof WorkloadIdentityError) {
    return 'Credenciais da API do Claude inválidas, ausentes ou expiradas. Rode `ant auth login` ou defina ANTHROPIC_API_KEY no .env.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Limite de uso da API atingido. Espere um pouco e tente de novo.';
  if (err instanceof Anthropic.APIConnectionError) return 'Sem conexão com a API do Claude.';
  if (err instanceof ProviderHttpError) {
    const label = serviceOf(`${err.service}/x`)?.service.label ?? err.service;
    if (err.status === 401 || err.status === 403) return `A ${label} recusou a chave (${err.status}): ${err.message}`;
    if (err.status === 402) return `Sem saldo na ${label}: ${err.message}`;
    if (err.status === 429) return `Limite de uso da ${label} atingido. Espere um pouco e tente de novo.`;
    return `Erro da ${label} (${err.status}): ${err.message}`;
  }
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
