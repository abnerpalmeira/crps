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

const STUDENTS: [string, string, string[]][] = [
  ['Yuki Sato', 'tranças e caderno cheio de desenhos', ['tímida', 'desenhista']],
  ['Haruto Mori', 'gravata frouxa e sorriso de quem aprontou', ['piadista']],
  ['Aiko Ueda', 'óculos redondos e postura impecável', ['representante de classe']],
  ['Ren Ito', 'cochila com o queixo apoiado na mão', ['dorminhoco']],
  ['Mei Kato', 'mochila cheia de chaveiros', ['falante']],
  ['Sora Abe', 'cabelo bagunçado, tênis de corrida', ['atleta']],
  ['Hina Fujita', 'fones de ouvido escondidos sob o cabelo', ['distraída']],
  ['Daichi Ono', 'mangas arregaçadas, mãos sujas de tinta', ['curioso']],
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
            },
            ...STUDENTS.map(([name, appearance, traits]) => ({ name, role: 'aluno(a) do 2º ano', appearance, traits, position: { seat: 'random' } })),
          ],
        }),
        call('create_items', {
          items: [
            { id: 'giz', name: 'Giz', description: 'um toco de giz branco, já gasto', holder: { character_id: 'voce' } },
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

function turnSteps(action: string, playerId: string, boardId: string | null): StepResult[] {
  const quoted = /["“](.+?)["”]/.exec(action)?.[1];
  const tools = [
    call('skill_check', { character_id: playerId, attribute: 'didatica', difficulty: 'normal', reason: action.slice(0, 60) }),
    call('advance_time', { minutes: 5, reason: 'o turno passou' }),
  ];
  if (boardId && /quadro/i.test(action)) tools.push(call('update_fixture', { fixture_id: boardId, append_text: quoted ?? new Date().toLocaleDateString('pt-BR') }));
  return [
    { text: '', stop: 'tool_use', toolCalls: tools },
    {
      text: [
        'O motor rolou os dados e o relógio andou cinco minutos.',
        `@${playerId}: ${quoted ?? 'Muito bem, turma. Vamos começar.'}`,
        '@aiko: Sim, professor!',
        '@haruto: *cochicha para a Mei* Ele tá de bom humor hoje.',
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
      const action = /Ação do jogador:\n"""\n([\s\S]*?)\n"""/.exec(opts.userMessage)?.[1] ?? '';
      const player = /\[([a-z0-9_]+)\] \(VOCÊ, jogador\)/.exec(opts.userMessage)?.[1] ?? 'voce';
      const board = /Ids de móveis começam com "([^"]+)\/"/.exec(opts.userMessage)?.[1];
      this.steps = turnSteps(action, player, board && opts.userMessage.includes('quadro-1:') ? `${board}/quadro-1` : null);
    }
  }

  async step(handlers: StepHandlers = {}): Promise<StepResult> {
    const next = this.steps.shift() ?? { text: '…', toolCalls: [], stop: 'end_turn' };
    await new Promise((r) => setTimeout(r, 250));
    for (const chunk of next.text.match(/\S+\s*/g) ?? []) {
      handlers.onText?.(chunk);
      await new Promise((r) => setTimeout(r, 18));
    }
    return next;
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
