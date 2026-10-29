import type { ModelProvider, ModelSession, SessionOptions, StepHandlers, StepResult, Verdict } from './provider';

/**
 * Provedor sem modelo, para mexer na interface sem gastar tokens
 * (CRPS_PROVIDER=offline). A criação do mundo segue um roteiro fixo de sala
 * de aula e cada turno só rola um teste e registra a ação.
 */
export const DEMO_CLASSROOM = [
  '#####BBBBBB######',
  '#.......TT......#',
  '#...............D',
  'W...d.d.d.d.d...#',
  '#...............#',
  'W...d.d.d.d.d...#',
  '#...............#',
  'W...d.d.d.d.d...D',
  '#ss.........kkkp#',
  '#################',
];

const STUDENTS: { name: string; appearance: string; traits: string[]; thoughts?: string; vida?: number }[] = [
  { name: 'Yuki Sato', appearance: 'tranças e caderno cheio de desenhos', traits: ['tímida', 'desenhista'], thoughts: 'torce para o professor não pedir o trabalho de história' },
  { name: 'Haruto Mori', appearance: 'gravata frouxa e sorriso de quem aprontou', traits: ['piadista'], thoughts: 'inventou a prova surpresa só para ver a cara da turma' },
  { name: 'Aiko Ueda', appearance: 'óculos redondos e postura impecável', traits: ['representante de classe'], thoughts: 'quer impressionar o professor' },
  { name: 'Ren Ito', appearance: 'cochila com o queixo apoiado na mão', traits: ['dorminhoco', 'gripado'], thoughts: 'só pensa em voltar a dormir', vida: 6 },
  { name: 'Mei Kato', appearance: 'mochila cheia de chaveiros', traits: ['falante'] },
  { name: 'Sora Abe', appearance: 'cabelo bagunçado, tênis de corrida', traits: ['atleta'] },
  { name: 'Hina Fujita', appearance: 'fones de ouvido escondidos sob o cabelo', traits: ['distraída'] },
  { name: 'Daichi Ono', appearance: 'mangas arregaçadas, mãos sujas de tinta', traits: ['curioso'] },
];

let nextId = 0;
const call = (name: string, input: unknown) => ({ id: `offline_${++nextId}`, name, input });

function setupSteps(): StepResult[] {
  return [
    {
      text: '',
      stop: 'tool_use',
      toolCalls: [
        call('define_ruleset', {
          name: 'Vida Escolar',
          attributes: [
            { name: 'Paciência', description: 'manter a calma com a turma' },
            { name: 'Carisma', description: 'conquistar e inspirar' },
            { name: 'Didática', description: 'explicar e conduzir a aula' },
          ],
          resources: [{ name: 'Energia', max: 10, description: 'fôlego até o fim do dia' }],
          perks: [
            { id: 'olho_clinico', name: 'Olho clínico', description: 'percebe na hora quem não está bem', grants: [{ kind: 'see_stat', stat: 'vida' }] },
            {
              id: 'le_a_turma',
              name: 'Lê a turma',
              description: 'anos de sala de aula: adivinha o que pensam os alunos que estão perto',
              grants: [{ kind: 'sense', channel: 'mente', bonus: 3 }],
            },
          ],
        }),
        call('create_location', { id: 'sala_2b', name: 'Sala 2-B', description: 'Sala de aula de uma escola japonesa, com janelas para o pátio.', layout: DEMO_CLASSROOM }),
        call('random', { min: 5, max: 8, reason: 'quantos alunos chegaram cedo' }),
      ],
    },
    {
      text: '',
      stop: 'tool_use',
      toolCalls: [
        call('create_characters', {
          characters: [
            {
              id: 'voce',
              name: 'Prof. Tanaka',
              role: 'professor de história',
              appearance: 'camisa social amassada e uma caneca de café',
              is_player: true,
              position: { near: 'sala_2b/quadro-1' },
              attributes: { paciencia: 3, carisma: 2, didatica: 3 },
              skills: { historia: 3, oratoria: 2 },
              perks: ['olho_clinico', 'le_a_turma'],
            },
            ...STUDENTS.map(({ vida, ...s }) => ({ ...s, role: 'aluno(a) do 2º ano', position: { seat: 'random' }, ...(vida ? { resources: { vida } } : {}) })),
          ],
        }),
        call('create_items', {
          items: [
            { id: 'giz', name: 'Giz', description: 'um toco de giz branco, já gasto', holder: { character_id: 'voce' } },
            {
              id: 'lanterna',
              name: 'Lanterna',
              description: 'lanterna de emergência guardada na gaveta',
              holder: { fixture_id: 'sala_2b/mesa-prof-1' },
              light: { radius: 5, intensity: 0.9, on: false },
            },
            { name: 'Caderno de chamada', description: 'capa azul, nomes em ordem alfabética', holder: { fixture_id: 'sala_2b/mesa-prof-1' } },
            { name: 'Apagador', description: 'apagador de feltro cheio de pó', holder: { fixture_id: 'sala_2b/quadro-1' } },
          ],
        }),
        call('advance_time', { to: '07:55', reason: 'início da aula' }),
        call('update_thread', { title: 'Primeira aula do dia', description: 'Dar a aula sobre o período Edo até o sinal das 8h50.' }),
        call('add_fact', { subject: 'yuki', text: 'Yuki ainda não entregou o trabalho de história', known_by: ['yuki'] }),
      ],
    },
    {
      text: [
        'O sol da manhã entra enviesado pelas janelas da Sala 2-B e acende o pó de giz que ainda flutua perto do quadro. ' +
          'Você gira o toco de giz entre os dedos enquanto a turma se acomoda.',
        '@haruto: Professor, é verdade que hoje tem prova surpresa?',
        '@aiko: Haruto, para de inventar coisa. *ajeita os óculos* Bom dia, professor!',
        '@ren: …zzz',
        '',
        'Alguém ri baixo no fundo. O Ren apoiou o queixo na mão como quem pretende dormir de olhos abertos.',
        '',
        '(Modo offline: este é um roteiro fixo. Conecte o Claude para o mestre de verdade montar o mundo e narrar.)',
      ].join('\n'),
      toolCalls: [],
      stop: 'end_turn',
    },
  ];
}

interface TurnContext {
  playerId: string;
  boardId: string | null;
  locationId: string | null;
  /** "Como o jogador marcou", do resumo: falas e sussurro viram falas do roteiro. */
  marked: string;
  /** O que o resumo do motor diz do jogador agora. */
  holdsLantern: boolean;
  blind: boolean;
  dark: boolean;
}

function turnSteps(action: string, ctx: TurnContext): StepResult[] {
  const { playerId, boardId, locationId } = ctx;
  const quoted = /["“](.+?)["”]/.exec(action)?.[1];
  const said = action.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const tools = [
    call('skill_check', { character_id: playerId, attribute: 'didatica', difficulty: 'normal', reason: action.slice(0, 60) }),
    call('advance_time', { minutes: 5, reason: 'o turno passou' }),
    // Para cochichar, Haruto precisa ir até a Mei: o motor recusa cochicho à distância.
    call('move_character', { character_id: 'haruto', to: { near: 'mei' } }),
  ];
  if (boardId && /quadro/i.test(action)) tools.push(call('update_fixture', { fixture_id: boardId, append_text: quoted ?? new Date().toLocaleDateString('pt-BR') }));
  // Palavras-chave para testar luz e visão sem modelo.
  const events: string[] = [];
  let { blind, dark } = ctx;
  if (locationId && /apag\w*.{0,6}luz|luz.{0,6}apag/.test(said)) {
    tools.push(call('update_location', { location_id: locationId, light: 0.06, reason: 'as luzes foram apagadas' }));
    events.push('O interruptor estala e a sala mergulha no escuro; só a fresta da porta deixa passar um fio de claridade.');
    dark = true;
  }
  if (locationId && /acend\w*.{0,6}luz|luz.{0,6}acend/.test(said)) {
    tools.push(call('update_location', { location_id: locationId, light: 1, reason: 'as luzes foram acesas' }));
    events.push('As lâmpadas piscam e voltam; a turma aperta os olhos.');
    dark = false;
  }
  if (/lanterna/.test(said)) {
    if (!ctx.holdsLantern) tools.push(call('transfer_item', { item_id: 'lanterna', to: { character_id: playerId } }));
    tools.push(call('update_item', { item_id: 'lanterna', light_on: true }));
    events.push('Você tateia a gaveta da mesa, acha a lanterna de emergência e acende. Um círculo amarelado corta o escuro.');
    dark = false;
  }
  if (/bomba|do bolso/.test(said)) {
    // Um mestre ingênuo tenta dar ao jogador o que ele pediu; o motor recusa (o jogador não tem perk de conjurar).
    tools.push(call('create_items', { items: [{ name: 'Bomba de fedor', description: 'ampola de vidro fedorenta', holder: { character_id: playerId } }] }));
    events.push('Você enfia a mão no bolso, mas os dedos só acham giz e papel: não tem bomba nenhuma ali.');
  }
  if (/experiment|quimic|reagente|bequer/.test(said)) {
    tools.push(call('update_character', { character_id: playerId, conditions_add: [{ id: 'cego', minutes: 15 }], resource_deltas: { vida: -1 } }));
    events.push('O béquer chia, espirra, e uma névoa ardida sobe direto para o seu rosto. Seus olhos queimam e a sala some num borrão escuro.');
    blind = true;
  }
  const seesRoom = !blind && !dark;
  // Sussurro marcado: o professor vai até a pessoa antes, e só ela ouve.
  const says = [...ctx.marked.matchAll(/^- fala \(em voz alta\): "(.*)"$/gm)].map((m) => m[1]);
  const whisper = /^- sussurro para (.+?) \[([a-z0-9_]+)\]: "(.*)"$/m.exec(ctx.marked);
  if (whisper) tools.push(call('move_character', { character_id: playerId, to: { near: whisper[2] } }));
  const playerLines = says.length ? says.map((s) => `@${playerId}: ${s}`) : whisper ? [] : [`@${playerId}: ${quoted ?? 'Muito bem, turma. Vamos começar.'}`];
  if (whisper) playerLines.push(`Você vai até ${whisper[1].split(' ')[0]} e se inclina.`, `@${playerId}[cochicho>${whisper[2]}]: ${whisper[3]}`);
  return [
    { text: '', stop: 'tool_use', toolCalls: tools },
    {
      text: [
        ...events,
        'O motor rolou os dados e o relógio andou cinco minutos.',
        ...playerLines,
        blind ? '@aiko[grito]: Professor! Lava os olhos, rápido!' : '@aiko: Sim, professor!',
        seesRoom ? 'Haruto se levanta, vai até a carteira da Mei e se inclina para ela.' : 'Uma cadeira arrasta; passos apressados vão até o fundo da sala.',
        '@haruto[cochicho>mei]: Ele tá de bom humor hoje.',
        '',
        '(Modo offline: sem o modelo, o mestre só registra a ação.)',
      ].join('\n'),
      toolCalls: [],
      stop: 'end_turn',
    },
  ];
}

class OfflineSession implements ModelSession {
  private readonly steps: StepResult[];

  constructor(opts: SessionOptions) {
    if (opts.userMessage.startsWith('Nova campanha')) this.steps = setupSteps();
    else {
      const brief = opts.userMessage;
      const action = /Ação do jogador:\n"""\n([\s\S]*?)\n"""/.exec(brief)?.[1] ?? '';
      const player = /\[([a-z0-9_]+)\] \(VOCÊ, jogador\)/.exec(brief)?.[1] ?? 'voce';
      const loc = /Ids de móveis começam com "([^"]+)\/"/.exec(brief)?.[1] ?? null;
      this.steps = turnSteps(action, {
        playerId: player,
        boardId: loc && brief.includes('quadro-1:') ? `${loc}/quadro-1` : null,
        locationId: loc,
        marked: /Como o jogador marcou:\n([\s\S]*)$/.exec(brief)?.[1] ?? '',
        holdsLantern: /Inventário: [^\n]*\[lanterna\]/.test(brief),
        blind: brief.includes('Visão: não enxerga nada'),
        dark: /luz onde está: escuro/.test(brief),
      });
    }
  }

  async step(handlers: StepHandlers = {}): Promise<StepResult> {
    const next = this.steps.shift() ?? { text: '…', toolCalls: [], stop: 'end_turn' };
    await new Promise((r) => setTimeout(r, 250));
    for (const chunk of next.text.match(/\S+\s*/g) ?? []) {
      handlers.onText?.(chunk);
      await new Promise((r) => setTimeout(r, 18));
    }
    // Uso zerado, para o custo e os créditos aparecerem na demo sem gasto.
    return { ...next, usage: { model: 'offline', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  }

  addToolResults(): void {}

  addUserText(): void {}
}

export class OfflineProvider implements ModelProvider {
  readonly label = 'offline (roteiro fixo)';

  startSession(opts: SessionOptions): ModelSession {
    return new OfflineSession(opts);
  }

  async verify(): Promise<{ verdict: Verdict }> {
    return { verdict: { consistent: true, issues: [] } };
  }
}
