import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { GameEngine } from '../engine/engine';
import { freeActSchema } from '../engine/free';
import type { Emit, GmEvent } from '../gm/gm';
import { MODEL_CHOICES, modelAvailable, modelChoice, serviceOf } from '../gm/models';
import { CostMeter, costEvent, describeCost, priceOf } from '../gm/pricing';
import { SaveStore, createGameMaster, creditUsdFromEnv, describeError, isOffline, loadEnv, loadModelCatalog, modeFromEnv, reloadServiceKeys } from '../gm/runtime';
import { ModelService } from './models';

loadEnv();
// Variável própria: PORT costuma ser definida para o servidor web (Vite) por quem o inicia.
const PORT = Number(process.env.CRPS_API_PORT ?? 8787);
const DIST = resolve('dist');
const MAX_TEXT = 2000;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const MODE = modeFromEnv();
const CREDIT_USD = creditUsdFromEnv();
const store = new SaveStore();
const catalog = loadModelCatalog();
const models = new ModelService(catalog);
let gm = createGameMaster({ model: store.loadSettings().model });
let engine: GameEngine | null = store.load();
let busy = false;
/** Uma ação livre em curso (ela pode esperar o Jev): outra ação ou um turno esperam. */
let acting = false;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64_000) throw new Error('Requisição grande demais.');
    chunks.push(chunk);
  }
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
}

async function readText(req: IncomingMessage, field: string): Promise<string> {
  const value = (await readJson(req))[field];
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

/** Transmite os eventos do turno em NDJSON e fecha com o custo. Quem chama já marcou `busy`. */
async function streamTurn(res: ServerResponse, run: (emit: Emit) => Promise<void>): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const send = (event: GmEvent) => {
    if (!res.writableEnded) res.write(`${JSON.stringify(event)}\n`);
  };
  const meter = new CostMeter();
  // No release, tokens e modelos não saem do servidor: o jogador só vê créditos.
  const emit = (event: GmEvent) => {
    if (event.type === 'usage') {
      meter.add(event.usage);
      if (MODE === 'release') return;
    }
    // No release, entrada e resultado das tools e o texto do verificador podem ter segredos.
    if (MODE === 'release' && event.type === 'tool') return send({ ...event, input: null, result: '' });
    if (MODE === 'release' && event.type === 'verify') return send({ ...event, issues: [] });
    send(event);
  };
  try {
    await run(emit);
  } catch (err) {
    console.error('[crps]', err);
    emit({ type: 'error', message: describeError(err) });
  } finally {
    if (engine) store.save(engine);
    // Turno que falhou no meio também gastou tokens: o custo é registrado igual.
    const cost = meter.summary();
    if (cost.requests) {
      const turn = engine?.state.turn ?? 0;
      const event = costEvent(cost, { mode: MODE, creditUsd: CREDIT_USD, turn });
      send(event);
      console.log(`[crps] turno ${turn}: US$ ${cost.usd.toFixed(4)} = ${event.credits} créditos · ${describeCost(cost)}`);
      store.appendLedger({
        at: new Date().toISOString(),
        campaign: engine?.state.id ?? null,
        turn,
        usd: Number(cost.usd.toFixed(6)),
        credits: event.credits,
        byModel: cost.byModel,
      });
    }
    busy = false;
    send({ type: 'done' });
    res.end();
  }
}

function serveStatic(pathname: string, res: ServerResponse): void {
  if (!existsSync(DIST)) {
    json(res, 404, { error: 'Interface não compilada: use `npm run dev` e abra http://localhost:5173, ou rode `npm run build`.' });
    return;
  }
  let file = join(DIST, normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(DIST + sep) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      // O seletor de modelo é do modo dev; na demo offline o mestre é um roteiro fixo.
      // Só os modelos com a chave do serviço no ambiente (o Claude sempre); a chave posta no .env
      // com o servidor no ar aparece no próximo pedido.
      reloadServiceKeys();
      const models =
        MODE === 'dev' && !isOffline() ? MODEL_CHOICES.filter((m) => modelAvailable(m.id)).map(({ fallback: _f, ...m }) => ({ ...m, price: priceOf(m.id) })) : [];
      json(res, 200, { world: engine?.snapshot() ?? null, busy, mode: MODE, model: MODE === 'dev' ? gm.label : '', models });
      return;
    }
    if (pathname === '/api/model' && req.method === 'POST') {
      if (MODE !== 'dev') return json(res, 403, { error: 'A troca de modelo só existe no modo de desenvolvimento.' });
      if (isOffline()) return json(res, 400, { error: 'Na demo offline o mestre é um roteiro fixo.' });
      const choice = modelChoice(await readText(req, 'model'));
      if (!choice) return json(res, 400, { error: `Modelo desconhecido. Opções: ${MODEL_CHOICES.map((m) => m.id).join(', ')}.` });
      if (!modelAvailable(choice.id)) return json(res, 400, { error: `Falta a chave: defina ${serviceOf(choice.id)?.service.keyEnv} no .env.` });
      if (busy) return json(res, 409, { error: 'Espere o mestre terminar o turno para trocar de modelo.' });
      gm = createGameMaster({ model: choice.id });
      store.saveSettings({ ...store.loadSettings(), model: choice.id });
      console.log(`[crps] mestre agora: ${gm.label}`);
      return json(res, 200, { model: gm.label });
    }
    if (pathname === '/api/new' && req.method === 'POST') {
      const premise = await readText(req, 'premise');
      if (!premise) return json(res, 400, { error: 'Escreva a premissa da campanha.' });
      if (busy || acting) return json(res, 409, { error: 'O mestre ainda está narrando.' });
      busy = true;
      // Se a criação falhar (créditos, login), a campanha anterior continua sendo a atual.
      const previous = engine;
      const fresh = GameEngine.create(premise);
      engine = fresh;
      await streamTurn(res, async (emit) => {
        try {
          await gm.setup(fresh, emit);
          store.archive();
        } catch (err) {
          engine = previous;
          throw err;
        }
      });
      return;
    }
    if (pathname === '/api/turn' && req.method === 'POST') {
      const input = await readText(req, 'input');
      if (!input) return json(res, 400, { error: 'Escreva sua ação.' });
      if (!engine) return json(res, 400, { error: 'Nenhuma campanha em andamento.' });
      if (busy || acting) return json(res, 409, { error: 'O mestre ainda está narrando.' });
      busy = true;
      const current = engine;
      await streamTurn(res, (emit) => gm.play(current, input, emit));
      return;
    }
    if (pathname === '/api/act' && req.method === 'POST') {
      // Ação livre no grid (andar, conversar): o motor resolve na hora, sem o mestre; o Jev escolhe a
      // fala que cabe e quem toma a iniciativa.
      if (!engine) return json(res, 400, { error: 'Nenhuma campanha em andamento.' });
      if (busy) return json(res, 409, { error: 'O mestre ainda está narrando.' });
      if (acting) return json(res, 409, { error: 'Espere a ação anterior terminar.' });
      const act = freeActSchema.safeParse(await readJson(req));
      if (!act.success) return json(res, 400, { error: 'Ação livre inválida.' });
      acting = true;
      try {
        const current = engine;
        const { usages: _usages, ...outcome } = await gm.free(current, act.data);
        if (outcome.entries.length) store.save(current);
        return json(res, 200, { ...outcome, world: current.snapshot() });
      } finally {
        acting = false;
      }
    }
    if (pathname === '/api/models/meta' && req.method === 'GET') {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const id = params.get('id') ?? '';
      const meta = await models.meta(id, params.get('as') === 'held');
      return meta ? json(res, 200, meta) : json(res, 404, { error: `Modelo ${id} indisponível.` });
    }
    if (pathname === '/api/models/guess' && req.method === 'GET') {
      // Item sem modelo (de campanhas antigas): o mais parecido pelo nome e pela descrição, da época
      // da campanha, só para o visual.
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const id = catalog?.suggest(params.get('name') ?? '', params.get('desc') ?? '', 1, engine?.state.era)[0]?.id;
      return id ? json(res, 200, { id }) : json(res, 404, { error: 'Nenhum modelo parecido.' });
    }
    if (pathname.startsWith('/api/models/file/') && req.method === 'GET') {
      const file = models.file(pathname.slice('/api/models/file/'.length));
      if (!file) return json(res, 404, { error: 'Arquivo de modelo inexistente.' });
      res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'public, max-age=86400' });
      res.end(readFileSync(file.path));
      return;
    }
    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Rota desconhecida.' });
    serveStatic(pathname, res);
  } catch (err) {
    console.error('[crps]', err);
    if (!res.headersSent) json(res, 500, { error: describeError(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[crps] servidor em http://127.0.0.1:${PORT} · modo ${MODE} · mestre: ${gm.label} · 1 crédito = US$ ${CREDIT_USD}` +
      `${engine ? ` · campanha carregada (turno ${engine.state.turn})` : ''}` +
      `${catalog ? ` · catálogo 3D: ${catalog.size} modelos` : ''}`,
  );
});
