# CRPS: Computerized Role-Playing System

RPG narrado por IA em que **a IA cuida da história e o motor cuida do estado**.
O modelo interpreta o jogador, improvisa e dá voz aos personagens. Personagens,
fichas, itens, posições, relógio, regras, sorteios e fatos ficam num motor
determinístico, e a IA só mexe neles por meio de tools validadas.
O mundo é um grid 2D, exibido em 3D low-poly no navegador.

```
jogador: "escrevo a data no quadro com o giz"
  → o motor compila o contexto do turno (cena, mapa, fichas, fios, fatos, últimos eventos)
  → o modelo chama tools ⇄ o motor valida, aplica, rola os dados
  → o modelo narra a partir dos resultados
  → um verificador compara narração × mudanças e, se precisar, pede correção
  → o 3D e os painéis mostram o novo estado
```

O modelo nunca carrega o histórico da campanha. Cada turno é uma conversa nova
com o resumo que o motor compila, então o prompt na hora 80 tem o mesmo tamanho
que na hora 1.

## Rodando

```bash
npm install
```

O mestre usa a API do Claude. As credenciais vêm de `ant auth login` ou de
`ANTHROPIC_API_KEY` num `.env` (veja `.env.example`).

```bash
npm run dev
```

Abra http://localhost:5173 (o Vite usa outra porta se essa estiver ocupada).
O servidor da API roda em 127.0.0.1:8787.

Outros comandos:

| Comando | O que faz |
|---|---|
| `npm run play` | Joga no terminal (`/estado` mostra o resumo do motor, `/novo`, `/sair`) |
| `npm run demo` | Interface com o provedor **offline**: roteiro fixo de sala de aula, sem modelo nem tokens (API em :8788, roda junto com o jogo real) |
| `npm test` | Testes do motor, do layout e do loop do mestre (com um provedor roteirizado) |
| `npm run build` | Typecheck e bundle de produção em `dist/` |
| `npm start` | Build e servidor único, em modo **release**, que serve a interface e a API em :8787 |
| `npm run demo:release` | A demo offline em modo release, para ver a interface que o jogador final vê |

A campanha atual fica em `saves/current.json`. Começar uma nova arquiva a anterior ao lado.

## Configuração

| Variável | Padrão | |
|---|---|---|
| `CRPS_MODEL` | `claude-opus-5-5` | Modelo do mestre |
| `CRPS_VERIFIER_MODEL` | `claude-haiku-5-5` | Verificador de consistência (barato) |
| `CRPS_EFFORT_SETUP` | `medium` | Esforço na criação do mundo |
| `CRPS_EFFORT_TURN` | `low` | Esforço nos turnos; suba se o mestre esquecer de chamar tools |
| `CRPS_VERIFY` | `1` | `0` desliga o verificador |
| `CRPS_PROVIDER` | `claude` | `offline` usa o roteiro fixo |
| `CRPS_SAVES` | `saves` | Pasta dos saves |
| `CRPS_API_PORT` | `8787` | Porta da API (o Vite encaminha `/api` para ela) |
| `CRPS_MODE` | `dev` | `release` mostra só créditos e esconde os bastidores (`npm start` já usa) |
| `CRPS_CREDIT_USD` | `0.01` | Quanto vale 1 crédito em US$ |

### Custo e créditos

O servidor soma o uso de todas as chamadas de cada turno (mestre, correções e verificador),
calcula o custo pela tabela de preços (`src/gm/pricing.ts`) e decide o que mostrar:

- **dev:** cada turno mostra o custo em US$ e em créditos, e o rodapé mostra o total da sessão e os
  tokens. O detalhe por modelo fica no tooltip e no log do servidor.
- **release:** o servidor não manda dólares, tokens nem nomes de modelo; o jogador vê só os
  créditos de cada turno e da sessão, e o botão de bastidores some.

Cada turno também vira uma linha em `saves/ledger.jsonl`, com US$, créditos e tokens por modelo,
nos dois modos. Um turno que falha no meio também entra na conta, porque já gastou tokens. Saldo,
compra de créditos e margem sobre o custo ainda não existem.

As chamadas ao Claude usam `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`):
se um classificador de segurança recusar um pedido legítimo (uma cena de luta, por
exemplo), a API refaz o pedido num modelo recomendado em vez de parar o turno.
O prompt de sistema e as tools ficam em cache (`cache_control`), e as tools usam
`eager_input_streaming`, porque o motor valida toda entrada com zod.

## Arquitetura

```
src/engine/   motor puro em TypeScript, sem rede (roda no servidor e nos testes)
  types.ts      modelo de dados: personagens, itens, locais, móveis, fatos, fios, relógio
  layout.ts     layout ASCII → local validado (paredes, conectividade, acesso, orientação)
  engine.ts     regras: posicionamento, caminhos, alcance, testes, fatos, tempo
  tools.ts      as 18 tools (schemas zod → JSON Schema) e a execução atômica
  perception.ts o que cada um percebe (visibilidade, sentidos e perks)
  speech.ts     falas: alcance de cada modo, quem ouve e o que o jogador vê
  brief.ts      o resumo do estado que o modelo recebe a cada turno
  frames.ts     falas `@id[modo>alvo]:` → passos do replay; retratos da cena por turno
src/gm/       o mestre
  gm.ts         loop do turno, eventos, verificador e rollback se a API falhar
  provider.ts   interface do provedor de modelo
  claude.ts     implementação com o SDK da Anthropic
  offline.ts    provedor de roteiro fixo
  prompts.ts    prompt de sistema, mensagem de criação e do verificador
src/server/   API HTTP (estado, novo jogo e turno em NDJSON)
src/client/   Three.js + painéis (Mestre, Ficha, Diário) e inspetor por clique
src/cli.ts    versão de terminal
```

Princípios que o motor impõe:

- **A IA propõe, o motor decide.** Mudanças concretas só via tools; uma tool que
  falha no meio desfaz tudo o que fez.
- **Gerar só o necessário, salvar tudo.** NPCs nascem como esboço e são aprofundados
  (`update_character`) quando ficam importantes; o que foi registrado não muda sozinho.
- **Estado subjetivo é dado.** Segredos, promessas e relações são fatos com `known_by`;
  fios narrativos têm status.
- **Cada personagem só sabe o que sabe.** Quem fica sabendo de um fato é registrado
  (`share_knowledge`), e só quem sabe pode contar. `known_by: "present"` registra quem
  estava na cena naquele momento, então quem chega depois não sabe. O resumo do turno diz
  ao mestre o que cada presente sabe e não sabe. O verificador aponta quando um personagem
  usa um fato que não conhece, ou quando a narração mostra alguém descobrindo algo sem o
  registro. Segredos que o personagem do jogador não conhece não aparecem para o jogador,
  só nos bastidores.
- **Regras como dados, e vivas.** Cada campanha define atributos, recursos, perks e mecânica
  de teste adequados ao gênero; o motor rola os dados. A história pode mudar de gênero no
  meio (a aula vira epidemia): `extend_ruleset` cria atributos (pontaria), recursos
  (infecção) e perks, e quem já existe recebe o valor padrão.
- **Vida universal e visibilidade.** Todo personagem tem vida, mesmo oculta. Cada atributo
  e recurso é `public` (o jogador vê de todos), `self` (só o próprio) ou `hidden` (só o mestre).
- **Perks ligados a traços**, com efeito aplicado pelo motor: `see_stat` (ver a vida de
  todos), `check_bonus` (+N em testes) e `sense`, que muda o alcance de um canal sensorial
  (veja [Falas, alcance e sentidos](#falas-alcance-e-sentidos)). Ler pensamentos é o canal
  `mente`: o mestre mantém o que cada NPC pensa em `thoughts`, e o resumo marca quais o
  jogador percebe agora. O verificador aponta quando a narração revela um valor oculto ou um
  pensamento que o jogador não percebe, e os chips não mostram o que ele não percebe.
- **O espaço importa.** Entregar algo exige estar a até 2 tiles; mover passa por
  busca de caminho; assentos e tiles não podem ser ocupados por dois. Falas e ações com
  alvo (`skill_check` com `target_id` e `reach`: toque, corpo a corpo, arremesso…) têm
  alcance, e o motor recusa o que está longe demais.

### Tools do mestre

| Tool | Para quê |
|---|---|
| `define_ruleset` | Atributos, recursos, perks e mecânica de teste da campanha |
| `extend_ruleset` | Regras novas no meio da campanha e mudanças de visibilidade |
| `create_location` | Local a partir de layout ASCII |
| `create_characters` | Personagens em lote (`seat: "random"` senta em assento livre) |
| `create_items` | Itens no inventário, sobre um móvel ou no chão |
| `random` | Sorteios (intervalo, lista ou dados) |
| `skill_check` | Teste resolvido pelo motor |
| `inspect` / `recall` | Consultar detalhes e fatos fora do resumo |
| `update_character` | Aprofundar NPCs, traços, dano e cura, perks e pensamentos |
| `move_character` | Mover por caminho, sentar, ir até alguém, trocar de local |
| `transfer_item` / `update_item` | Pegar, entregar, largar, consumir |
| `update_fixture` | Escrever no quadro (aparece no 3D), abrir portas |
| `add_fact` / `update_thread` | Memória da história |
| `share_knowledge` | Quem ficou sabendo de um fato (só quem sabe pode contar) |
| `advance_time` | Relógio |

### Replay com balões de fala

Cada turno é um frame. O mestre escreve cada fala numa linha própria, `@id: fala`
(gestos curtos entre asteriscos; modos e alvos na seção seguinte). No 3D, cada fala vira um
balão sobre quem fala, com até três na tela, os mais antigos esmaecendo, e a narração vira
legenda. O balão do cochicho é tracejado e o do grito, em negrito. No fim de cada turno o
motor guarda um retrato da cena (posições, itens, quadro, relógio), então voltar a um
frame antigo mostra o mundo como estava naquele momento.

Controles no palco: ⏮ turno anterior · ‹ fala anterior · ▶ tocar/pausar · › próxima fala ·
⏭ próximo turno · "ao vivo" volta ao presente. Com o foco fora da caixa de texto: ← →,
espaço e Esc. Cada turno do painel tem um botão "▶ rever", e o turno novo toca sozinho
quando termina.

### Falas, alcance e sentidos

Cada fala diz o modo e, quando há, o alvo:

| Linha | Alvo a até | Ouvem o conteúdo (audição normal) |
|---|---|---|
| `@haruto: Bom dia!` | — | quem está a até 12 tiles |
| `@haruto[>mei]: Bom dia!` | 12 tiles | idem, dirigida à Mei |
| `@haruto[cochicho>mei]: Ele tá de bom humor.` | 2 tiles | só a Mei |
| `@haruto[grito]: Socorro!` | 40 tiles | o local inteiro |

O motor confere cada fala antes de aceitar a narração: cochichar com quem está do outro lado
da sala vira correção para o mestre (mover antes ou trocar a ação), na mesma rodada do
verificador. Depois calcula quem percebeu. O conteúdo de uma fala que nem todos ouviram vira
fato conhecido só por quem ouviu, e, se o personagem do jogador não percebeu, o jogador vê
só o gesto (🤫 "cochicha algo para Mei"). A troca acontece no servidor, inclusive durante o
streaming; o texto original fica nos bastidores.

Quem percebe depende de canais sensoriais, que são dados como o resto das regras. `som`,
`labios` e `mente` vêm de fábrica (só o som funciona sem perk), e o alcance num canal é o
alcance base do modo × o multiplicador do personagem + bônus em tiles. Perks `sense` mudam
isso:

| Perk (exemplo) | Grant | Efeito |
|---|---|---|
| Super audição | `{ "kind": "sense", "channel": "som", "multiplier": 4 }` | ouve cochichos a até 2 tiles e falas a até 48 |
| Leitura labial | `{ "kind": "sense", "channel": "labios", "multiplier": 1 }` | lê cochichos a até 3 tiles e falas a até 6 |
| Telepatia | `{ "kind": "sense", "channel": "mente", "bonus": 8 }` | percebe pensamentos e falas de quem está a até 8 tiles |

Modos de fala, canais e alcances novos (um rádio, língua de sinais, telepatia como modo de
fala) entram com `extend_ruleset` quando a história pede, sem mudar o código.

### Layout ASCII

Um caractere por tile (~1 m). Porta, janela e quadro ficam na linha da parede; o motor
orienta carteiras para o quadro e a mesa do professor para a turma.

```
#####BBBB#####     # parede   . chão    D porta   W janela   B quadro
#............#     T mesa do professor  d carteira (assento)  c cadeira
#.....TT.....#     t mesa   s estante   k armário   p planta   b cama
#............#     S sofá   C balcão    x caixa     ' ' vazio/exterior
W.d.d.d.d.d..#
#............D
W.d.d.d.d.d..#
##############
```

Se o layout tiver erro (caractere desconhecido, chão encostando no exterior, regiões
desconectadas, móvel sem corredor), a tool devolve os erros com coordenadas e o modelo
corrige.

## Próximos passos

- Trocar as primitivas por assets low-poly CC0 (Kenney, KayKit, Quaternius).
- Agenda dos NPCs e eventos disparados pelo relógio (o sinal da escola, o intervalo).
- Navegar entre locais no 3D e gerar o local vizinho sob demanda.
- Avaliação automática do mestre: roteiros de jogador e checagem de consistência ao longo de muitos turnos.
