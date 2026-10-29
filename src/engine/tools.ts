import { z } from 'zod';
import { EngineError, VISIBILITY_LABEL, type GameEngine } from './engine';
import { legendSummary } from './layout';
import { lightLabel } from './light';
import { perceptionOf } from './perception';
import { truncate } from './text';
import type { Fact } from './types';

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

/** Fatos que o personagem do jogador não conhece aparecem só nos bastidores (🤫). */
function playerKnows(engine: GameEngine, fact: Fact): boolean {
  return engine.player ? engine.knows(engine.player.id, fact) : fact.knownBy === 'all';
}

const statMap = z.record(z.string(), z.number());

const visibility = z.enum(['public', 'self', 'hidden']).describe('public: o jogador vê de todos; self: só o próprio; hidden: só o mestre.');

const perkGrant = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('see_stat'), stat: z.string().describe('Atributo ou recurso que o dono do perk vê em todos.') }),
  z.object({ kind: z.literal('see_thoughts') }),
  z.object({
    kind: z.literal('check_bonus'),
    bonus: z.number().int().min(-5).max(5),
    attribute: z.string().optional().describe('Só em testes deste atributo.'),
    skill: z.string().optional().describe('Só em testes com esta perícia.'),
  }),
  z.object({
    kind: z.literal('sense'),
    channel: z.string().describe('Canal sensorial: som, labios, mente, visao ou um canal novo.'),
    multiplier: z.number().optional().describe('Substitui o multiplicador base do canal (som e visao 1; labios e mente 0). Ex.: super audição = som 4.'),
    bonus: z.number().optional().describe('Tiles a mais de alcance. Ex.: telepatia = mente +8; visão no escuro = visao +6 (vê sem luz até 6 tiles).'),
    factor: z.number().optional().describe('Multiplica o alcance final: 0 = perdeu o sentido (cego = visao 0), 0.5 = turvo.'),
  }),
  z.object({
    kind: z.literal('conjure'),
    note: z.string().optional().describe('O que dá para tirar do nada, ex. "objetos pequenos de mágico".'),
    cost: z
      .object({ resource: z.string(), amount: z.number().int() })
      .optional()
      .describe('Recurso gasto a cada item, ex. {"resource": "energia", "amount": 2}.'),
  }),
  z.object({
    kind: z.literal('light'),
    radius: z.number().describe('Alcance da luz em tiles.'),
    intensity: z.number().optional().describe('Força de 0 a 1 (padrão 0.9).'),
    color: z.string().optional().describe('Cor CSS, ex. "#9fd0ff".'),
  }),
]);

const lightInput = z.object({
  radius: z.number().describe('Alcance da luz em tiles: vela 2, lanterna 5, holofote 10.'),
  intensity: z.number().optional().describe('Força de 0 a 1 (padrão 0.9).'),
  color: z.string().optional().describe('Cor CSS, ex. "#ffd9a0".'),
  on: z.boolean().optional().describe('Já acesa? Padrão false.'),
});

const perkInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  grants: z.array(perkGrant).max(4).describe('Efeitos aplicados pelo motor; vazio = perk só narrativo.'),
});

const attributeInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  visibility: visibility.optional().describe('Padrão: self.'),
  default: z.number().int().min(0).max(5).optional().describe('Valor de quem não informar.'),
});

const resourceInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  max: z.number().int().min(1).max(1000),
  description: z.string(),
  visibility: visibility.optional().describe('Padrão: self.'),
  start: z.number().int().optional().describe('Valor de quem já existe (padrão: o máximo).'),
});

/** Campos de personagem que qualquer um percebe; o resto de um NPC só aparece nos bastidores. */
const OPEN_FIELDS = new Set(['name', 'role', 'appearance', 'figure', 'traits']);

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

const figure = z.enum(['adulto', 'adulta', 'menino', 'menina']).describe('Corpo no 3D: adulto, adulta, menino ou menina (crianças e adolescentes).');

const characterInput = z.object({
  id: z.string().optional().describe('Slug curto e estável, ex. "yuki". Se omitido, vem do primeiro nome.'),
  name: z.string(),
  role: z.string().describe('Papel ou profissão, ex. "aluna do 2º ano".'),
  appearance: z.string().describe('Uma ou duas frases.'),
  figure: figure.optional(),
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
  perks: z.array(z.string()).optional().describe('Ids de perks do ruleset.'),
  thoughts: z.string().optional().describe('O que pensa ou quer agora; oculto do jogador, salvo perk see_thoughts.'),
});

const itemInput = z.object({
  id: z.string().optional(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
  quantity: z.number().int().min(1).optional(),
  holder,
  light: lightInput.optional().describe('Para itens que iluminam (lanterna, vela, tocha).'),
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
      'Define as regras da campanha: 2 a 6 atributos, até 4 recursos, perks e a mecânica de teste, adequados ao gênero ' +
      '(slice of life escolar: Paciência, Carisma, Didática; recursos Energia e Dinheiro). O motor sempre inclui o recurso ' +
      'universal vida, oculto por padrão; para mudar o máximo ou a visibilidade dele, inclua um recurso "Vida". Chame uma ' +
      'única vez, na criação do mundo, antes de criar personagens; depois disso, use extend_ruleset.',
    schema: z.object({
      name: z.string(),
      attributes: z.array(attributeInput).min(2).max(6),
      resources: z.array(resourceInput).max(4),
      perks: z.array(perkInput).max(8).optional(),
      conditions: z.array(perkInput).max(6).optional().describe('Condições além das prontas (cego, visao_turva, ofuscado, surdo).'),
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
      const shown = r.attributes.filter((a) => a.visibility !== 'hidden').map((a) => a.name);
      return { content: r, summary: `📜 Regras: ${r.name} (${shown.join(', ')})` };
    },
  }),

  tool({
    name: 'extend_ruleset',
    description:
      'Muda as regras no meio da campanha, quando a história muda de rumo (a aula vira uma epidemia, a investigação vira ' +
      'tiroteio): novos atributos (ex.: pontaria), recursos (ex.: infecção), perks, condições (ex.: envenenado), a ' +
      'visibilidade de atributos e recursos, modos de fala (ex.: telepatia), sentidos base, canais que exigem ver quem emite ' +
      '(ex.: língua de sinais), limiares de visão e alcances de ação (ex.: tiro). Quem já existe recebe o valor padrão ' +
      '(attributes.default, padrão 0; resources.start, padrão o máximo); ajuste os relevantes com update_character. Chame ' +
      'antes de usar a regra nova.',
    schema: z.object({
      attributes: z.array(attributeInput).max(4).optional(),
      resources: z.array(resourceInput).max(4).optional(),
      perks: z.array(perkInput).max(6).optional(),
      conditions: z.array(perkInput).max(6).optional().describe('Estados que vêm e vão, com os mesmos efeitos de um perk.'),
      visibility: z.record(z.string(), visibility).optional().describe('Ex.: {"vida": "public"} quando o combate começa.'),
      speech_modes: z
        .record(
          z.string(),
          z.object({
            label: z.string().describe('Verbo para a interface, ex. "transmite por telepatia".'),
            reach: z.number().describe('Distância máxima até o alvo, em tiles.'),
            channels: z.record(z.string(), z.number()).describe('Alcance do conteúdo por canal sensorial, ex. {"mente": 20}.'),
          }),
        )
        .optional(),
      senses: z.record(z.string(), z.number()).optional().describe('Multiplicador base de um canal para todos, ex. {"olfato": 1}.'),
      reaches: z.record(z.string(), z.number()).optional().describe('Alcance de ações com alvo, ex. {"tiro_pistola": 20}.'),
      sight_channels: z.array(z.string()).optional().describe('Canais que só funcionam vendo quem emite, ex. ["sinais"].'),
      vision: z
        .object({
          clear: z.number().optional().describe('Clareza mínima para ver nítido (padrão 0.35).'),
          dim: z.number().optional().describe('Clareza mínima para ver um vulto (padrão 0.12).'),
          dim_penalty: z.number().int().optional().describe('Penalidade contra alvo visto como vulto (padrão 1).'),
          blind_penalty: z.number().int().optional().describe('Penalidade contra alvo que não se vê (padrão 3).'),
        })
        .optional(),
      reason: z.string(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.extendRuleset(input);
      const label = (a: (typeof r.added)[number]) =>
        a.kind === 'visibilidade' ? `${a.name} agora ${VISIBILITY_LABEL[a.visibility!]}` : `${a.kind} ${a.name}`;
      // Perks e condições do catálogo e regras ocultas não aparecem para o jogador.
      const shown = r.added.filter((a) => a.kind !== 'perk' && a.kind !== 'condição' && a.visibility !== 'hidden');
      return {
        content: r,
        summary: shown.length ? `📜 Regras ampliadas: ${shown.map(label).join(', ')}` : `🤫 Regras ampliadas: ${r.added.map(label).join(', ')}`,
      };
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
      light: z.number().optional().describe('Luz ambiente de 0 a 1: 1 dia claro ou luzes acesas (padrão), 0.5 penumbra, 0.1 noite, 0 breu.'),
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
      'mudar de mãos precisa existir aqui antes de ser usado ou narrado. No meio do jogo, nada é criado direto com o personagem ' +
      'do jogador (salvo perk de conjurar): crie onde o objeto está e entregue com transfer_item.',
    schema: z.object({ items: z.array(itemInput).min(1).max(30) }),
    mutates: true,
    run(engine, input) {
      const created = input.items.map((spec) => engine.createItem(spec));
      const conjured = created.map((i) => engine.conjuredBy(i));
      return {
        content: {
          created: created.map((i, k) => ({
            id: i.id,
            name: i.name,
            quantity: i.quantity,
            where: engine.describeHolder(i.holder),
            ...(conjured[k] ? { conjured_by: conjured[k]!.name } : {}),
          })),
        },
        summary: `${conjured.some(Boolean) ? '✨' : '📦'} ${created
          .map((i, k) => `${i.name} (${engine.describeHolder(i.holder)})${conjured[k] ? ` · ${conjured[k]!.name}` : ''}`)
          .join('; ')}`,
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
      'resultado, nunca o contradiga. Use quando o resultado não for óbvio; ações triviais não precisam de teste. Ação com ' +
      'alvo (empurrar, atacar, tocar, arremessar, examinar de perto): informe target_id e reach; o motor recusa se o alvo ' +
      'estiver longe demais e penaliza sozinho quem age contra um alvo que não vê bem (escuro, cegueira).',
    schema: z.object({
      character_id: z.string(),
      attribute: z.string().describe('Id ou nome de um atributo do ruleset.'),
      skill: z.string().optional().describe('Perícia relevante; se o personagem não tiver, conta 0.'),
      difficulty,
      modifier: z.number().int().optional().describe('Bônus ou penalidade da situação (-3 a +3).'),
      reason: z.string().describe('O que está sendo tentado, em poucas palavras.'),
      target_id: z.string().optional().describe('Personagem alvo da ação, se houver.'),
      reach: z
        .union([z.string(), z.number()])
        .optional()
        .describe('Alcance da ação com alvo: chave de reaches (toque, corpo_a_corpo, arremesso, visao…) ou tiles. Padrão: visao.'),
      needs_sight: z.boolean().optional().describe('false para ações com alvo que não dependem de ver (telepatia). Padrão true.'),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.skillCheck(input);
      const label = `🎲 ${r.character} · ${r.attribute.name}${r.skill ? ` + ${r.skill.id}` : ''} (${r.reason})`;
      // Atributo que o jogador não vê (de um NPC, ou oculto): só os dados e o resultado.
      if (!perceptionOf(engine.state, engine.state.playerId).canSeeStat(r.attribute.id, r.character_id)) {
        return { content: r, summary: `${label}: ${r.rolls.join('+')} → ${r.degree}` };
      }
      const parts = [r.attribute.value, r.skill?.value ?? 0, r.modifier].filter((v) => v !== 0).map((v) => (v > 0 ? ` +${v}` : ` ${v}`));
      if (r.perk_bonus) parts.push(` ${r.perk_bonus > 0 ? '+' : ''}${r.perk_bonus} (${r.perks.join(', ')})`);
      if (r.sight_penalty) parts.push(` -${r.sight_penalty} (${r.against?.sight === 'nada' ? 'sem ver o alvo' : 'alvo num vulto'})`);
      return { content: r, summary: `${label}: ${r.rolls.join('+')}${parts.join('')} = ${r.total} vs ${r.target} → ${r.degree}` };
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
      'detalhes na narração; para mudar traços, atributos e perícias; para dano e cura (resource_deltas: {"vida": -3}) e ' +
      'outros recursos; para dar ou tirar perks; para condições que vêm e vão (cego, visao_turva, ofuscado, surdo ou as ' +
      'criadas com extend_ruleset), com minutes quando passam sozinhas; e para registrar o que um NPC pensa ou quer agora (thoughts).',
    schema: z.object({
      character_id: z.string(),
      name: z.string().optional(),
      role: z.string().optional(),
      appearance: z.string().optional(),
      figure: figure.optional(),
      traits_add: z.array(z.string()).optional(),
      traits_remove: z.array(z.string()).optional(),
      personality: z.string().optional(),
      background: z.string().optional(),
      goals: z.string().optional(),
      attributes: statMap.optional(),
      skills: statMap.optional().describe('Nível 0 remove a perícia.'),
      resource_deltas: statMap.optional().describe('Ex. {"energia": -2}.'),
      resources_set: statMap.optional(),
      perks_add: z.array(z.string()).optional(),
      perks_remove: z.array(z.string()).optional(),
      conditions_add: z
        .array(z.union([z.string(), z.object({ id: z.string(), minutes: z.number().optional().describe('Quanto dura; sem minutes, até ser removida.') })]))
        .optional()
        .describe('Ex.: [{"id": "cego", "minutes": 30}].'),
      conditions_remove: z.array(z.string()).optional(),
      thoughts: z.string().optional().describe('O que pensa ou quer agora; string vazia apaga.'),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateCharacter(input);
      const c = engine.findCharacter(r.character_id);
      const view = perceptionOf(engine.state, engine.state.playerId);
      // O chip mostra só o que o jogador percebe; o resto vai para os bastidores.
      const shown: string[] = [];
      const hidden: string[] = [];
      for (const field of r.changed) {
        const text =
          field === 'perks'
            ? `perks: ${engine.perksOf(c).map((p) => p.name).join(', ') || 'nenhum'}`
            : field === 'conditions'
              ? `condições: ${engine.conditionLabels(c).join(', ') || 'nenhuma'}`
              : field;
        (OPEN_FIELDS.has(field) || (c.isPlayer && field !== 'thoughts') ? shown : hidden).push(text);
      }
      for (const id of r.attributes) (view.canSeeStat(id, c.id) ? shown : hidden).push(id);
      for (const x of r.resources) (view.canSeeStat(x.id, c.id) ? shown : hidden).push(`${x.id} ${x.before}→${x.after}/${x.max}`);
      const summary = shown.length ? `✏️ ${c.name}: ${shown.join(', ')}` : `🤫 ${c.name}: ${hidden.join(', ') || 'sem mudanças'}`;
      return { content: r, summary };
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
    description:
      'Altera um item (nome, descrição, tags, quantidade), acende ou apaga uma luz (light_on), transforma em luz (light) ou o ' +
      'destrói quando é consumido ou quebrado.',
    schema: z.object({
      item_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      quantity_delta: z.number().int().optional(),
      destroy: z.boolean().optional(),
      light_on: z.boolean().optional().describe('Acende (true) ou apaga (false) um item que ilumina.'),
      light: lightInput.nullable().optional().describe('Define a luz do item; null tira.'),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateItem(input);
      if (r.destroyed) return { content: r, summary: `🗑️ ${input.item_id} acabou` };
      if (input.light_on === undefined) return { content: r, summary: `📦 ${r.name} atualizado` };
      return { content: r, summary: `🔦 ${r.name}: luz ${input.light_on ? 'acesa' : 'apagada'}` };
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
    name: 'update_location',
    description:
      'Muda a luz ambiente de um local (acender ou apagar as luzes, anoitecer, queda de energia), o nome ou a descrição. ' +
      'light vai de 0 (breu) a 1 (dia claro ou luzes acesas); 0.5 é penumbra, 0.1 é noite com pouca luz.',
    schema: z.object({
      location_id: z.string(),
      light: z.number().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      reason: z.string(),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.updateLocation(input);
      const light = r.light.after !== r.light.before ? ` luz ${lightLabel(r.light.before)} → ${lightLabel(r.light.after)}` : ' atualizado';
      return { content: r, summary: `${r.light.after < r.light.before ? '🌑' : r.light.after > r.light.before ? '💡' : '🗺️'} ${r.name}:${light}` };
    },
  }),

  tool({
    name: 'add_fact',
    description:
      'Registra algo que a história precisa lembrar: segredos, promessas, relações, opiniões, o que alguém testemunhou. ' +
      'known_by diz quem sabe dentro da ficção: "all" para fatos públicos, "present" para todos que estão no local agora ' +
      '(quem chegar depois não sabe), ou uma lista de ids (pode incluir "player" e "present"). Registre no momento em que acontece.',
    schema: z.object({
      subject: z.string().describe('Id do personagem, local ou item principal; ou um tema curto.'),
      text: z.string(),
      known_by: z.union([z.literal('all'), z.literal('present'), z.array(z.string())]),
    }),
    mutates: true,
    run(engine, input) {
      const f = engine.addFact(input);
      return {
        content: { fact_id: f.id, subject: f.subject, known_by: f.knownBy },
        summary: `${playerKnows(engine, f) ? '📌' : '🤫'} ${truncate(f.text, 70)}`,
      };
    },
  }),

  tool({
    name: 'share_knowledge',
    description:
      'Registra que personagens ficaram sabendo de um fato já registrado: alguém contou (from), ouviram uma conversa, viram ' +
      'algo acontecer. Chame antes de narrar a descoberta. Só quem sabe pode contar: from precisa conhecer o fato. to aceita ' +
      'ids, "player" ou "present" (todos no local de quem conta, ou do jogador).',
    schema: z.object({
      fact_id: z.string(),
      to: z.union([z.literal('present'), z.array(z.string()).min(1)]),
      from: z.string().optional().describe('Quem contou ou mostrou, se alguém contou.'),
      how: z.string().describe('Como ficaram sabendo, em poucas palavras.'),
    }),
    mutates: true,
    run(engine, input) {
      const r = engine.shareKnowledge(input);
      const fact = engine.findFact(r.fact_id);
      if (!r.learned.length) return { content: r, summary: `🤫 ninguém novo ficou sabendo de ${fact.id}` };
      const names = r.learned.map((id) => engine.state.characters[id]?.name.split(' ')[0] ?? id);
      return {
        content: r,
        summary: `${playerKnows(engine, fact) ? '👂' : '🤫'} ${names.join(', ')} agora sabe${names.length > 1 ? 'm' : ''}: ${truncate(fact.text, 60)}`,
      };
    },
  }),

  tool({
    name: 'recall',
    description:
      'Busca fatos e fios registrados: por assunto (id), por palavras e/ou só o que um personagem sabe (known_by). Use ' +
      'antes de afirmar algo do passado que não está no resumo do turno, ou para conferir o que um NPC sabe antes de ele falar.',
    schema: z.object({
      subject: z.string().optional(),
      query: z.string().optional(),
      known_by: z.string().optional().describe('Só fatos que este personagem conhece (inclui os públicos).'),
      limit: z.number().int().optional(),
    }),
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
      const ended = r.expired.map((e) => `${e.character}: ${e.condition} passou`);
      return { content: r, summary: `🕒 ${r.from} → ${r.to}${ended.length ? ` · ${ended.join('; ')}` : ''}` };
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
