import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { CatalogItem, ModelCatalog } from '../engine/catalog';

/**
 * Modelos do catálogo convertidos sob demanda: o 3D pede um id (`town:SM_Prop_Sofa_02`), o
 * servidor converte o FBX com o Blender na primeira vez (scripts/assets/convert_model.py) e guarda
 * o GLB, a ficha e as texturas em public/models/cache, fora do git. Sem Blender ou sem o
 * repertório, o 3D segue com as primitivas. Um objeto que vai na mão de alguém (`held`) é outra
 * conversão do mesmo modelo: a origem fica no punho, onde o arquivo a pôs, e não na base.
 */

const CACHE = resolve('public', 'models', 'cache');
const SCRIPT = resolve('scripts', 'assets', 'convert_model.py');
const BLENDER = process.env.CRPS_BLENDER ?? 'blender';
/** Conversões ao mesmo tempo: cada uma é um Blender. */
const PARALLEL = 2;
const TIMEOUT_MS = 180_000;

export interface ModelMeta {
  file: string;
  kind: 'prop' | 'character' | 'held';
  size: [number, number, number];
  head?: number;
  /** Na mão: a caixa do modelo em volta da origem (o punho), para achar o cano e a lâmina. */
  bbox?: [[number, number, number], [number, number, number]];
  materials: Record<string, { texture: string | null; cutout?: boolean; tint?: [number, number, number] }>;
  category: string;
  figure?: string;
}

const MIME: Record<string, string> = { '.glb': 'model/gltf-binary', '.png': 'image/png' };

function keyOf(item: CatalogItem, held: boolean): string {
  return item.id.replace(':', '__').replace(/[^A-Za-z0-9_.-]/g, '_') + (held ? '__mao' : '');
}

export class ModelService {
  private pending = new Map<string, Promise<ModelMeta | null>>();
  private failed = new Set<string>();
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(private catalog: ModelCatalog | null) {}

  /** A ficha do modelo pronto para o 3D, convertendo se preciso; null se não há como. */
  meta(id: string, held = false): Promise<ModelMeta | null> {
    const item = this.catalog?.get(id);
    // Personagem não vai na mão de ninguém.
    if (!item || item.sensivel || (held && item.category === 'personagem')) return Promise.resolve(null);
    const key = keyOf(item, held);
    if (this.failed.has(key)) return Promise.resolve(null);
    let promise = this.pending.get(key);
    if (!promise) {
      promise = this.load(item, key, held).finally(() => this.pending.delete(key));
      this.pending.set(key, promise);
    }
    return promise;
  }

  /** Caminho de um arquivo do cache (GLB ou textura), ou null fora dele. */
  file(name: string): { path: string; type: string } | null {
    const path = join(CACHE, normalize(decodeURIComponent(name)));
    const type = MIME[path.slice(path.lastIndexOf('.'))];
    if (!path.startsWith(CACHE + sep) || !type || !existsSync(path)) return null;
    return { path, type };
  }

  private async load(item: CatalogItem, key: string, held: boolean): Promise<ModelMeta | null> {
    const json = join(CACHE, `${key}.json`);
    if (!existsSync(json)) {
      await this.slot();
      try {
        await this.convert(item, key, held);
      } catch (err) {
        console.error(`[modelos] ${item.id}: ${(err as Error).message}`);
        this.failed.add(key);
        return null;
      } finally {
        this.release();
      }
    }
    const meta = JSON.parse(readFileSync(json, 'utf8')) as Omit<ModelMeta, 'category' | 'figure'>;
    return { ...meta, category: item.category, ...(item.figure ? { figure: item.figure } : {}) };
  }

  private convert(item: CatalogItem, key: string, held: boolean): Promise<void> {
    const kind = item.category === 'personagem' ? 'character' : held ? 'held' : 'prop';
    const args = ['-b', '--python-exit-code', '1', '--python', SCRIPT, '--', item.src, item.pack, kind, CACHE, key];
    return new Promise((done, fail) => {
      const child = spawn(BLENDER, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      const keep = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-4000);
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        fail(new Error(`Blender indisponível (${err.message}); defina CRPS_BLENDER.`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && existsSync(join(CACHE, `${key}.json`))) {
          console.log(`[modelos] convertido ${item.id}${held ? ' (na mão)' : ''}`);
          done();
        } else fail(new Error(`conversão saiu com ${code}: ${log.split('\n').filter((l) => /error|erro|modelo/i.test(l)).slice(-3).join(' | ')}`));
      });
    });
  }

  private slot(): Promise<void> {
    if (this.running < PARALLEL) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((go) => this.waiting.push(go));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}
