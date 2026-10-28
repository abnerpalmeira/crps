import { z } from 'zod';
import { EngineError, type GameEngine } from './engine';
import { legendSummary } from './layout';
import { truncate } from './text';

/**
 * A API que o modelo enxerga. Cada tool valida a entrada com zod, chama o
 * motor e devolve JSON para o modelo e um resumo curto para a interface.
 */
interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  mutates: boolean;
  run(engine: GameEngine, input: z.infer<S>): { content: unknown; summary: string };
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const statMap = z.record(z.string(), z.number());

const placement = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    seat: z.string().optional().describe('Id de um assento (carteira, cadeira, sofá…) ou "random" para sortear um assento livre.'),
    near: z.string().optional().describe('Id de um móvel ou personagem: fica no tile livre mais próximo dele.'),
  })
  .describe('Exatamente um modo: {x, y}, {seat} ou {near}.');

const holder = z
  .object({
    character_id: z.string().optional(),
    fixture_id: z.string().optional().describe('Em cima/dentro de um móvel, ex. "sala_1a/mesa-prof-1".'),
    location_id: z.string().optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
  })
  .describe('Exatamente um: {character_id}, {fixture_id} ou {x, y} no chão (+ location_id se for outro local).');

const characterInput = z.object({
  id: z.string().optional().describe('Slug curto e estável, ex. "yuki". Se omitido, vem do primeiro nome.'),
  name: z.string(),
  role: z.string().describe('Papel ou profissão, ex. "aluna do 2º ano".'),
  appearance: z.string().describe('Uma ou duas frases.'),
  traits: z.array(z.string()).max(6).optional().describe('1 a 3 traços marcantes.'),
  is_player: z.boolean().optional(),
  attributes: statMap.optional().describe('Atributos do ruleset (0 a 5). Não informados ficam em 1.'),
  skills: statMap.optional().describe('Perícias livres (0 a 5), ex. {"didatica": 3}.'),
  resources: statMap.optional().describe('Valores iniciais de recursos; o padrão é o máximo.'),
  personality: z.string().optional(),
  background: z.string().optional(),
  goals: z.string().optional(),
  location_id: z.string().optional().describe('Padrão: local do jogador ou o último local criado.'),
  position: placement.optional().describe('Padrão: perto da porta.'),
  offscreen: z.boolean().optional().describe('true = existe no mundo mas não está em nenhum local agora.'),
  facing: z.string().optional().describe('N/S/E/W ou id de algo para olhar.'),
});

const itemInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  quantity: z.number().int().min(1).optional(),
  holder,
});

const difficulty = z.union([z.enum(['facil', 'normal', 'dificil', 'muito_dificil']), z.number().int()]);

export const EXAMPLE_CLASSROOM = [
  '#####BBBB#####',
  '#............#',
  '#.....TT.....#',
  '#............#',
  'W.d.d.d.d.d..#',
  '#............D',
  'W.d.d.d.d.d..#',
  '#............#',
  'W.d.d.d.d.d..#',
  '#............#',
  '##############',
].join('\n');

export const TOOLS = [
  tool({
    name: 'define_ruleset',
    description:
      'Define as regras da campanha: 2 a 6 atributos, até 4 recursos e a mecânica de teste, adequados ao gênero ' +
      '(slice of life escolar: Paciência, Carisma, Didática; recursos Energia e Dinheiro). Chame uma única vez, ' +
      'na criação do mundo, antes de criar personagens.',
    schema: z.object({
      name: z.string(),
      attributes: z.array(z.object({ id: z.string().optional(), name: z.string(), description: z.string() })).min(2).max(6),
      resources: z
        .array(z.object({ id: z.string().optional(), name: z.string(), max: z.number().int().min(1).max(1000), description: z.string() }))
        .max(4),
      dice: z.string().optional().describe('Padrão "2d6".'),
      difficulties: z
        .object({ facil: z.number().int(), normal: z.number().int(), dificil: z.number().int(), muito_dificil: z.number().int() })
        .partial()
        .optional()
        .describe('Padrão para 2d6: fácil 7, normal 9, difícil 11, muito difícil 13.'),
      notes: z.string().optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.defineRuleset(input);
      return { content: r, summary: `📜 Regras: ${r.name} (${r.attributes.map((a) => a.name).join(', ')})` };
    },
  }),

  tool({
    name: 'create_location',
    description:
      'Cria um local a partir de um grid ASCII (1 caractere = 1 tile de ~1 m). O motor valida e devolve os ids dos móveis; ' +
      'se houver erro, corrija o layout e chame de novo. Regras: paredes "#" fecham o perímetro; porta "D", janela "W" e ' +
      'quadro "B" ficam NA linha da parede; deixe corredores "." para tudo ser alcançável; todas as linhas com a mesma largura. ' +
      `Legenda: ${legendSummary()}. Sala de aula típica: 12 a 16 colunas × 9 a 12 linhas. Exemplo:\n${EXAMPLE_CLASSROOM}`,
    schema: z.object({
      id: z.string().optional().describe('Slug curto, ex. "sala_1a". Se omitido, vem do nome.'),
      name: z.string(),
      description: z.string(),
      layout: z.union([z.string(), z.array(z.string())]).describe('Uma string com quebras de linha, ou uma string por fileira.'),
      floor: z.enum(['wood', 'tile', 'stone', 'carpet', 'grass', 'dirt']).optional(),
      outdoor: z.boolean().optional().describe('true para áreas abertas (pátio, rua, floresta): dispensa paredes no perímetro.'),
    }),
    mutates: true,
    run(engine, input) {
      const { location, warnings } = engine.createLocation(input);
      const fixtures = location.fixtures.map(
        (f) => `${f.id}: ${f.label} (${f.x},${f.y})${f.w > 1 || f.h > 1 ? ` ${f.w}×${f.h}` : ''}, frente ${f.facing}`,
      );
      return {
        content: { location_id: location.id, size: `${location.width}×${location.height}`, fixtures, warnings },
        summary: `🗺️ Local: ${location.name} (${location.width}×${location.height}, ${location.fixtures.length} móveis)`,
      };
    },
  }),

  tool({
    name: 'create_characters',
    description:
      'Cria personagens em lote (até 30). Crie NPCs como esboço: nome, papel, aparência e 1 a 3 traços. Personalidade e ' +
      'história só quando o NPC ficar relevante (update_character). Para alunos em carteiras use position {seat: "random"}. ' +
      'Exatamente um personagem do jogo tem is_player=true. Entradas com erro voltam listadas; corrija só essas.',
    schema: z.object({ characters: z.array(characterInput).min(1).max(30) }),
    mutates: true,
    run(engine, input) {
      const created: unknown[] = [];
      const errors: unknown[] = [];
      input.characters.forEach((spec, index) => {
        try {
          const c = engine.createCharacter(spec);
          created.push({ id: c.id, name: c.name, location: c.locationId, position: c.pos, seat: c.seatId });
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          errors.push({ index, name: spec.name, error: err.message });
        }
      });
      if (!created.length) throw new EngineError(`Nenhum personagem criado: ${JSON.stringify(errors)}`);
      return {
        content: { created, errors },
        summary: `🧑 ${created.length} personagem(ns)${errors.length ? `, ${errors.length} com erro` : ''}: ${input.characters
          .map((c) => c.name)
          .slice(0, 6)
          .join(', ')}${input.characters.length > 6 ? '…' : ''}`,
      };
    },
  }),

  tool({
    name: 'create_items',
    description:
      'Cria itens em lote: no inventário de alguém, sobre um móvel ou no chão. Todo objeto que importe para a história e possa ' +
      'mudar de mãos precisa existir aqui antes de ser usado ou narrado.',
    schema: z.object({ items: z.array(itemInput).min(1).max(30) }),
    mutates: true,
    run(engine, input) {
      const created = input.items.map((spec) => engine.createItem(spec));
      return {
        content: { created: created.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, where: engine.describeHolder(i.holder) })) },
        summary: `📦 ${created.map((i) => `${i.name} (${engine.describeHolder(i.holder)})`).join('; ')}`,
      };
    },
  }),

  tool({
    name: 'random',
    description:
      'Gera aleatoriedade de verdade. Use sempre que algo deva ser sorteado (quantidades, quem é escolhido, eventos ao acaso) ' +
      'em vez de inventar o número. Modos: {min, max}, {options, count} ou {dice: "1d6"}.',
    schema: z.object({
      min: z.number().int().optional(),
      max: z.number().int().optional(),
      options: z.array(z.string()).optional(),
      count: z.number().int().optional(),
      dice: z.string().optional(),
      reason: z.string(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.random(input);
      const shown = r.mode === 'range' ? r.value : r.mode === 'pick' ? r.picked.join(', ') : `${r.rolls.join('+')} = ${r.total}`;
      return { content: r, summary: `🎲 ${input.reason}: ${shown}` };
    },
  }),

  tool({
    name: 'skill_check',
    description:
      'Resolve uma ação incerta com consequências. O motor rola os dados e decide sucesso ou falha; narre de acordo com o ' +
      'resultado, nunca o contradiga. Use quando o resultado não for óbvio; ações triviais não precisam de teste.',
    schema: z.object({
      character_id: z.string(),
      attribute: z.string().describe('Id ou nome de um atributo do ruleset.'),
      skill: z.string().optional().describe('Perícia relevante; se o personagem não tiver, conta 0.'),
      difficulty,
      modifier: z.number().int().optional().describe('Bônus ou penalidade da situação (-3 a +3).'),
      reason: z.string().describe('O que está sendo tentado, em poucas palavras.'),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.skillCheck(input);
      const extra = [r.attribute.value, r.skill?.value ?? 0, r.modifier].filter((v) => v !== 0);
      const math = `${r.rolls.join('+')}${extra.map((v) => (v > 0 ? ` +${v}` : ` ${v}`)).join('')}`;
      return {
        content: r,
        summary: `🎲 ${r.character} · ${r.attribute.name}${r.skill ? ` + ${r.skill.id}` : ''} (${r.reason}): ${math} = ${r.total} vs ${r.target} → ${r.degree}`,
      };
    },
  }),

  tool({
    name: 'inspect',
    description:
      'Lê detalhes que não estão no resumo do turno: ficha completa de personagens, itens, móveis, locais, fios ou fatos. ' +
      'Consulte antes de afirmar algo que você não tem certeza se existe.',
    schema: z.object({ ids: z.array(z.string()).min(1).max(12) }),
    mutates: false,
    run(engine, input) {
      return { content: engine.inspect(input.ids), summary: `🔎 ${input.ids.join(', ')}` };
    },
  }),

  tool({
    name: 'update_character',
    description:
      'Atualiza um personagem. Use para aprofundar um NPC esboço (personality, background, goals) ANTES de revelar esses ' +
      'detalhes na narração, para mudar traços, atributos e perícias, e para gastar ou recuperar recursos (resource_deltas).',
    schema: z.object({
      character_id: z.string(),
      name: z.string().optional(),
      role: z.string().optional(),
      appearance: z.string().optional(),
      traits_add: z.array(z.string()).optional(),
      traits_remove: z.array(z.string()).optional(),
      personality: z.string().optional(),
      background: z.string().optional(),
      goals: z.string().optional(),
      attributes: statMap.optional(),
      skills: statMap.optional().describe('Nível 0 remove a perícia.'),
      resource_deltas: statMap.optional().describe('Ex. {"energia": -2}.'),
      resources_set: statMap.optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateCharacter(input);
      const name = engine.findCharacter(r.character_id).name;
      return { content: r, summary: `✏️ ${name}: ${[...r.changed, ...r.resources].join(', ') || 'sem mudanças'}` };
    },
  }),

  tool({
    name: 'move_character',
    description:
      'Move um personagem: para um tile {x, y}, para um assento {seat}, para perto de algo ou alguém {near}, ou para outro ' +
      'local {location_id}. O motor calcula o caminho e recusa destinos ocupados ou inalcançáveis. "face" vira o personagem ' +
      'para uma direção (N/S/E/W) ou para algo.',
    schema: z.object({
      character_id: z.string(),
      to: placement.extend({ location_id: z.string().optional() }),
      face: z.string().optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.moveCharacter(input);
      const name = engine.findCharacter(r.character_id).name;
      const where = r.to.seat ? r.to.seat.split('/').pop() : `(${r.to.x},${r.to.y})`;
      const { path: _path, ...content } = r;
      return { content, summary: `🚶 ${name} → ${where}${r.from?.location !== r.to.location ? ` em ${r.to.location}` : ''}` };
    },
  }),

  tool({
    name: 'transfer_item',
    description:
      'Muda um item de lugar: pegar, entregar, largar, guardar. O motor exige que origem e destino estejam a até 2 tiles ' +
      '(8 com thrown=true). Use quantity para entregar só parte de uma pilha.',
    schema: z.object({
      item_id: z.string(),
      to: holder,
      quantity: z.number().int().optional(),
      thrown: z.boolean().optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.transferItem(input);
      return { content: r, summary: `📦 ${r.name}${r.quantity > 1 ? ` ×${r.quantity}` : ''}: ${r.from} → ${r.to}` };
    },
  }),

  tool({
    name: 'update_item',
    description: 'Altera um item (nome, descrição, tags, quantidade) ou o destrói quando é consumido ou quebrado.',
    schema: z.object({
      item_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      quantity_delta: z.number().int().optional(),
      destroy: z.boolean().optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateItem(input);
      return { content: r, summary: r.destroyed ? `🗑️ ${input.item_id} acabou` : `📦 ${r.name} atualizado` };
    },
  }),

  tool({
    name: 'update_fixture',
    description:
      'Muda o estado de um móvel: o que está escrito no quadro (text substitui, append_text acrescenta uma linha) ou um estado ' +
      'curto como "aberta", "trancada", "quebrada". O texto do quadro aparece no mundo 3D.',
    schema: z.object({
      fixture_id: z.string(),
      text: z.string().optional(),
      append_text: z.string().optional(),
      state: z.string().optional(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateFixture(input);
      return { content: r, summary: `📝 ${r.fixture_id.split('/').pop()}: ${r.text ? `"${truncate(r.text.replace(/\n/g, ' / '), 60)}"` : r.state}` };
    },
  }),

  tool({
    name: 'add_fact',
    description:
      'Registra algo que a história precisa lembrar: segredos, promessas, relações, opiniões, o que alguém testemunhou. ' +
      'known_by lista quem sabe dentro da ficção (ids ou "player"); "all" para fatos públicos. Registre no momento em que acontece.',
    schema: z.object({
      subject: z.string().describe('Id do personagem, local ou item principal; ou um tema curto.'),
      text: z.string(),
      known_by: z.union([z.literal('all'), z.array(z.string())]),
    }),
    mutates: true,
    run(engine, input) {
      const f = engine.addFact(input);
      return { content: { fact_id: f.id, subject: f.subject }, summary: `📌 ${truncate(f.text, 70)}` };
    },
  }),

  tool({
    name: 'recall',
    description:
      'Busca fatos e fios registrados: por assunto (id) e/ou por palavras. Use antes de afirmar algo do passado que não ' +
      'está no resumo do turno.',
    schema: z.object({ subject: z.string().optional(), query: z.string().optional(), limit: z.number().int().optional() }),
    mutates: false,
    run(engine, input) {
      const r = engine.recall(input);
      return { content: r, summary: `🧠 Lembrar: ${input.subject ?? ''} ${input.query ?? ''}`.trim() };
    },
  }),

  tool({
    name: 'update_thread',
    description: 'Cria ou atualiza um fio narrativo (objetivo, mistério, conflito em aberto). Sem id ou com id novo, cria; com id existente, atualiza.',
    schema: z.object({
      id: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['open', 'resolved', 'failed']).optional(),
    }),
    mutates: true,
    run(engine, input) {
      const t = engine.updateThread(input);
      return { content: t, summary: `🧵 ${t.title} (${t.status})` };
    },
  }),

  tool({
    name: 'advance_time',
    description:
      'Avança o relógio quando o tempo passa de forma relevante (minutes ou to "HH:MM"). Na criação do mundo, to define o ' +
      'horário inicial. O relógio só anda para frente.',
    schema: z.object({ minutes: z.number().int().optional(), to: z.string().optional(), reason: z.string() }),
    mutates: true,
    run(engine, input) {
      const r = engine.advanceTime(input);
      return { content: r, summary: `🕒 ${r.from} → ${r.to}` };
    },
  }),
];

const TOOL_MAP = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t as unknown as ToolDef]));

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

function toJsonSchema(schema: z.ZodType): ToolSpec['input_schema'] {
  const js = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete js.$schema;
  // Remove ruído que só gasta tokens: limites de inteiro seguro e propertyNames de records.
  const noise = (key: string, value: unknown) =>
    key === 'propertyNames' || ((key === 'minimum' || key === 'maximum') && Math.abs(Number(value)) === Number.MAX_SAFE_INTEGER);
  return JSON.parse(JSON.stringify(js, (key, value) => (noise(key, value) ? undefined : value)));
}

/** Definições em JSON Schema, em ordem fixa (estável para o cache do prompt). */
export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t.schema) }));
}

export interface ToolResult {
  ok: boolean;
  /** JSON (ou mensagem de erro) que volta para o modelo. */
  content: string;
  /** Linha curta para a interface. */
  summary: string;
  mutated: boolean;
  data?: unknown;
}

/** Executa uma tool de forma atômica: se a regra falhar no meio, o estado volta ao que era. */
export function runTool(engine: GameEngine, name: string, input: unknown): ToolResult {
  const def = TOOL_MAP.get(name);
  if (!def) return { ok: false, content: `Tool desconhecida: ${name}.`, summary: `⚠️ tool desconhecida: ${name}`, mutated: false };
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      content: `Entrada inválida para ${name}:\n${z.prettifyError(parsed.error)}`,
      summary: `⚠️ ${name}: entrada inválida`,
      mutated: false,
    };
  }
  const before = def.mutates ? JSON.stringify(engine.state) : null;
  try {
    const { content, summary } = def.run(engine, parsed.data);
    return { ok: true, content: JSON.stringify(content), summary, mutated: def.mutates, data: content };
  } catch (err) {
    if (before) engine.state = JSON.parse(before);
    if (err instanceof EngineError) {
      return { ok: false, content: err.message, summary: `⚠️ ${name}: ${truncate(err.message.split('\n')[0], 90)}`, mutated: false };
    }
    throw err;
  }
}
