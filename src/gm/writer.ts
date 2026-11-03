import { z } from 'zod';
import { GESTURE_LIST } from './prompts';

/**
 * O escritor: no turno em que o jogador só conversa, o motor e o Jev já decidiram o que importa (a
 * reação de quem o jogador procura e o que essa pessoa conta), e uma chamada só, sem tools, escreve
 * o turno. O que a conversa muda no mundo vem no mesmo JSON (fatos, quem soube, apresentações,
 * sentimentos, pensamentos, falas prontas, o tempo), e o motor aplica pelas mesmas tools do mestre,
 * com as mesmas validações.
 */

const line = z.object({
  texto: z.string().describe('a fala, curta, só o que a pessoa diz'),
  fato: z.string().nullable().describe('id do fato registrado que a fala conta, ou null'),
  diz_o_nome: z.boolean().describe('a pessoa diz o próprio nome nesta fala'),
  cochicho: z.boolean().describe('segredo: só o jogador ouve'),
});

export const WriterSchema = z.object({
  narracao: z.string().describe('a narração do turno, com as falas @id e as marcas de gesto'),
  acoes: z.array(z.string()).describe('três ações que o jogador pode tomar agora'),
  fatos: z
    .array(z.object({ assunto: z.string().describe('id de personagem, item ou local'), texto: z.string(), sabem: z.array(z.string()).describe('ids de quem sabe agora') }))
    .describe('o que a conversa revelou de novo e a história precisa lembrar'),
  contados: z
    .array(z.object({ fato: z.string().describe('id do fato já registrado'), para: z.array(z.string()), de: z.string().nullable().describe('quem contou, ou null') }))
    .describe('quem ficou sabendo de um fato já registrado'),
  apresentados: z
    .array(z.object({ quem: z.string().describe('id de quem disse o nome ou foi apresentado'), para: z.array(z.string()).describe('ids de quem passa a conhecê-lo') }))
    .describe('quem disse o próprio nome, ou foi apresentado, e a quem'),
  sentimentos: z
    .array(z.object({ quem: z.string(), por_quem: z.string(), grau: z.number().int().describe('de -3 a +3'), texto: z.string().describe('o que sente e por quê, numa frase') }))
    .describe('o que a conversa mudou no que um NPC sente, e o que faltava'),
  pensamentos: z.array(z.object({ quem: z.string(), texto: z.string() })).describe('o que um NPC passa a pensar ou querer'),
  falas: z
    .array(
      z.object({
        quem: z.string().describe('id do NPC'),
        do_turno: z.array(line).describe('o que diria em seguida'),
        gerais: z.array(line).describe('vazio mantém as gerais que a pessoa já tem'),
        iniciativa: z.enum(['vem', 'chama', 'nenhuma']),
      }),
    )
    .describe('falas prontas dos NPCs em cena'),
  minutos: z.number().int().describe('quanto tempo a conversa levou'),
});

export type Writing = z.infer<typeof WriterSchema>;

export const WRITER_PROMPT = `Você é o escritor do CRPS (Computerized Role-Playing System), um RPG narrado por IA feito para qualquer pessoa jogar. Neste turno o jogador só conversa, e o motor já decidiu o que importa: como reage a pessoa com quem ele fala e o que ela conta ("Decidido pelo motor"). Você escreve o turno numa resposta só, sem tools: o JSON pedido, com a narração e o que a conversa mudou, que o motor registra.

# O que vai no JSON
- narracao: a narração do turno (regras abaixo).
- acoes: três ações que o jogador pode tomar agora, como ele as escreveria: curtas (até 12 palavras), na primeira pessoa, com a fala entre aspas quando ele fala. Uma arrisca, uma tem cautela, uma segue um fio da história, só com o que o personagem dele sabe e percebe.
- fatos: o que a conversa revelou de novo e a história vai precisar lembrar (segredos, promessas, opiniões, quem viu o quê): assunto (id de personagem, item ou local), texto e sabem (ids de quem sabe agora: quem disse e quem ouviu na narração). Vazio se nada.
- contados: quem ficou sabendo de um fato já registrado (seção Conhecimento do resumo) na cena desta narração, porque alguém contou ou porque ouviu: o id do fato, para quem e quem contou (null se ninguém contou a ele, só ouviu). Só o que a narração mostra, e só quem sabe pode contar. Que o jogador soube do fato decidido, o motor já registrou; quem mais ouviu vai aqui. O que uma fala pronta vai contar depois não entra: o motor registra quem ouvir quando ela tocar.
- apresentados: quem disse o próprio nome nesta cena, ou foi apresentado, e a quem; daí em diante eles o conhecem.
- sentimentos: o que a conversa mudou no que um NPC sente por alguém (grau de -3 a +3, a boa vontade com a pessoa, e o porquê numa frase), um ou dois pontos por vez e pelo jeito dele; e o sentimento que falta em quem reage ao jogador (o resumo aponta "falta sentimento por"), mesmo que seja indiferença (grau 0). Só NPCs: o que o personagem do jogador sente, quem diz é o jogador.
- pensamentos: o que um NPC passa a pensar ou querer depois da conversa, numa frase, só para quem mudou.
- falas: as falas prontas dos NPCs em cena, para o jogador puxar conversa depois, sem você. Em do_turno, o que cada um diria em seguida, do ponto de vista dele, pelo que sabe, sente e quer, e nunca o que acabou de dizer na narração. Em gerais, falas do jeito da pessoa para qualquer momento, só para quem o resumo marca "sem falas gerais"; para os outros, deixe vazio, e as que eles têm ficam. Uma a três de cada, curtas. A fala que conta um fato registrado leva o id dele em fato (só quem sabe pode contar); diz_o_nome quando a pessoa diz o próprio nome; cochicho para segredo, que só o jogador ouve. iniciativa: "vem" (vai até o jogador) ou "chama" (de onde está) para quem tem motivo para puxar conversa; "nenhuma" para os outros.
- minutos: quanto tempo a conversa levou, em geral de 1 a 5.

# O que você não faz
Neste turno ninguém muda de lugar, de postura ou de mãos, nem o personagem do jogador, que fala de onde está (se ele precisava chegar perto, o motor já o levou), nenhuma pessoa ou objeto aparece, nada se quebra ou se acende, e nenhum teste é rolado: se a cena pedir isso, mostre a intenção sem consumar (alguém faz menção de levantar, promete ir buscar). Não contradiga o "Decidido pelo motor": a pessoa reage assim e conta o que foi decidido, nem mais nem menos. O jogador decide as falas e as atitudes do personagem dele: narre o que ele escreveu, sem acrescentar falas nem decisões dele.

# Narração
- Segunda pessoa ("você"), tempo presente, em português do Brasil.
- Curta e viva: um ou dois parágrafos, mais as falas. Cada personagem fala com a própria voz, e os NPCs em cena reagem do jeito deles: pelo papel, pelo que pensam, querem e sentem por quem está ali.
- Cada fala vai sozinha numa linha, com o id de quem fala, inclusive a do personagem do jogador, com as palavras dele: \`@id: fala\` (voz normal), \`@id[>alvo]: fala\` (dirigida a alguém), \`@id[cochicho>alvo]: fala\` (só entre quem está colado), \`@id[grito]: fala\`. Nada de travessão ou aspas para diálogo. Um gesto curto pode ir na fala, entre asteriscos; os que o 3D anima vão como marca \`{id:gesto}\` ou \`{id:gesto>alvo}\`, na frase em que acontecem: ${GESTURE_LIST}. Todo gesto da lista que alguém faz leva a marca, inclusive o que a narração só descreve (encolher os ombros, apontar); os asteriscos ficam para o que a lista não tem. Exemplo, com quem o jogador ainda não conhece:
  A recepcionista ergue os olhos da agenda e balança a cabeça. {hana:nao}
  @hana[>ren]: Hoje não tem mais mesa, senhor.
- Termine com a cena aberta, sem perguntar "o que você faz?". Fora o prefixo das falas e as marcas de gesto, não escreva ids, coordenadas nem números de regras.

# Conhecimento e percepção
- Cada personagem só sabe os fatos registrados para ele (seção Conhecimento do resumo) e o que vê e ouve agora. Quem não sabe pode desconfiar, perguntar ou errar, mas não acerta por acaso um segredo.
- Quem o jogador não conhece não tem nome para ele: chame pelo que ele vê (o seen_as do resumo) até o nome aparecer na história; quem se apresenta vai em apresentados.
- Quem fala em voz normal é ouvido por quem está perto: quem ouviu um fato registrado vai em contados, e um fato novo leva em sabem todos que ouviram.
- Narre só o que o personagem do jogador percebe: o conteúdo de um cochicho entre outros fica de fora; de quem ele não vê, nada visual; pensamentos e sentimentos alheios, só os que o resumo marca "(o jogador percebe)". Não revele números que o jogador não vê.`;

/** Na reescrita, cada tool que a conferência cita e o campo do JSON que faz o mesmo. */
const FIELDS =
  'add_fact em fatos, share_knowledge em contados, introduce em apresentados, set_feelings em sentimentos, update_character thoughts em pensamentos, set_lines em falas (fact_id é fato, introduces é diz_o_nome, whisper é cochicho)';

/** A mensagem do turno para o escritor: o resumo, a ação do jogador, o decidido e, numa reescrita, o que corrigir. */
export function writerMessage(brief: string, input: string, marked: string[], decided: string[], fix?: { previous: Writing; issues: string[] }): string {
  const again = fix
    ? `

O motor conferiu a sua resposta anterior e apontou:
${fix.issues.map((i) => `- ${i}`).join('\n')}
Escreva o JSON de novo, corrigido: ele substitui o anterior inteiro. O que o motor não pode registrar neste turno (alguém muda de lugar, de postura ou de mãos, uma pessoa ou um objeto novo) sai da narração ou fica só na intenção; o que falta registrar vai no campo da tool citada: ${FIELDS}. A narração começa direto pela história, sem falar da correção. A resposta anterior:
${JSON.stringify(fix.previous)}`
    : '';
  return `${brief}

---
Ação do jogador:
"""
${input}
"""${marked.length ? `\nComo o jogador marcou:\n${marked.join('\n')}` : ''}

Decidido pelo motor (escreva assim; que o jogador soube do fato contado, o motor já registrou):
${decided.map((d) => `- ${d}`).join('\n')}${again}`;
}

/** A narração com as ações no fim, como o mestre escreve: daí em diante o turno segue o mesmo caminho. */
export function writtenText(out: Writing): string {
  const options = out.acoes
    .map((a) => a.replace(/^\s*>+\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return [out.narracao.trim(), '', ...options.map((a) => `>> ${a}`)].join('\n').trim();
}

export interface WritingCall {
  /** O campo do JSON de onde veio a chamada, para a reescrita apontar onde corrigir. */
  field: keyof Writing;
  name: string;
  input: unknown;
}

const ready = (l: z.infer<typeof line>) => ({
  text: l.texto.slice(0, 240),
  ...(l.fato ? { fact_id: l.fato } : {}),
  ...(l.diz_o_nome ? { introduces: true } : {}),
  ...(l.cochicho ? { whisper: true } : {}),
});

/**
 * O que o escritor mudou, como chamadas às tools do mestre, na ordem em que o motor aplica: os fatos
 * e quem soube antes das falas que os contam. O que o personagem do jogador sente e pensa fica com o
 * jogador, e o que a tool recusaria por tamanho é cortado aqui.
 */
export function writingCalls(out: Writing, playerId: string | null): WritingCall[] {
  const calls: WritingCall[] = [];
  const npc = (id: string) => id !== playerId;
  for (const f of out.fatos) if (f.texto.trim()) calls.push({ field: 'fatos', name: 'add_fact', input: { subject: f.assunto, text: f.texto, known_by: f.sabem } });
  for (const c of out.contados) {
    if (c.para.length) calls.push({ field: 'contados', name: 'share_knowledge', input: { fact_id: c.fato, to: c.para, ...(c.de ? { from: c.de } : {}), how: 'na conversa' } });
  }
  for (const a of out.apresentados) if (a.para.length) calls.push({ field: 'apresentados', name: 'introduce', input: { who: a.para, knows: [a.quem], mutual: false } });
  const feelings = out.sentimentos.filter((s) => npc(s.quem)).slice(0, 40);
  if (feelings.length) {
    const degree = (n: number) => Math.max(-3, Math.min(3, Math.round(n)));
    calls.push({ field: 'sentimentos', name: 'set_feelings', input: { feelings: feelings.map((s) => ({ who: s.quem, toward: s.por_quem, degree: degree(s.grau), text: s.texto })) } });
  }
  for (const p of out.pensamentos) if (npc(p.quem)) calls.push({ field: 'pensamentos', name: 'update_character', input: { character_id: p.quem, thoughts: p.texto } });
  const lines = out.falas.filter((f) => npc(f.quem)).slice(0, 30);
  if (lines.length) {
    calls.push({
      field: 'falas',
      name: 'set_lines',
      input: {
        lines: lines.map((f) => ({
          who: f.quem,
          turn: f.do_turno.slice(0, 4).map(ready),
          ...(f.gerais.length ? { general: f.gerais.slice(0, 4).map(ready) } : {}),
          initiative: f.iniciativa,
        })),
      },
    });
  }
  const minutes = Math.min(Math.max(0, Math.round(out.minutos)), 240);
  if (minutes) calls.push({ field: 'minutos', name: 'advance_time', input: { minutes, reason: 'a conversa' } });
  return calls;
}
