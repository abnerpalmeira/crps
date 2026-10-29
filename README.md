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
| `CRPS_MODEL` | `claude-haiku-5-5` | Modelo do mestre (a escolha feita na interface tem prioridade) |
| `CRPS_VERIFIER_MODEL` | `claude-haiku-5-5` | Verificador de consistência (barato) |
| `CRPS_EFFORT_SETUP` | `medium` | Esforço na criação do mundo |
| `CRPS_EFFORT_TURN` | `low` | Esforço nos turnos; suba se o mestre esquecer de chamar tools |
| `CRPS_VERIFY` | `1` | `0` desliga o verificador |
| `CRPS_PROVIDER` | `claude` | `offline` usa o roteiro fixo |
| `CRPS_SAVES` | `saves` | Pasta dos saves |
| `CRPS_API_PORT` | `8787` | Porta da API (o Vite encaminha `/api` para ela) |
| `CRPS_MODE` | `dev` | `release` mostra só créditos e esconde os bastidores (`npm start` já usa) |
| `CRPS_CREDIT_USD` | `0.01` | Quanto vale 1 crédito em US$ |

No modo dev, clicar no nome do modelo no topo do painel abre o seletor do mestre: Fable 5.1,
Opus 5.5, Opus 5, Sonnet 5.5 ou Haiku 5.5, com o preço por milhão de tokens de cada um. A troca
vale a partir do próximo turno e fica salva em `saves/settings.json`, então sobrevive ao
reinício do servidor. O verificador continua no `CRPS_VERIFIER_MODEL`. O Haiku 5.5 não tem
fallback no servidor quando recusa, então o mestre não pede fallback a ele. O seletor não
aparece no release nem na demo offline.

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
  templates.ts  layouts prontos: saguão de prédio e corredor de andar
  engine.ts     regras: posicionamento, caminhos, alcance, testes, fatos, tempo
  tools.ts      as 20 tools (schemas zod → JSON Schema) e a execução atômica
  effects.ts    efeitos de perks e condições de cada personagem
  light.ts      luz por tile: ambiente do local, itens acesos e poderes de luz
  perception.ts o que cada um percebe (visibilidade, sentidos, visão e perks)
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
- **O inventário do jogador é a verdade.** No meio do jogo, nenhum item é criado direto com
  ele, nem a pilha dele cresce sozinha: o que existe no mundo é criado onde está e chega até
  ele com `transfer_item`. Tirar coisas do nada só com um perk de conjurar
  (`{ "kind": "conjure", "note": "objetos pequenos", "cost": { "resource": "energia", "amount": 2 } }`).
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
| `introduce` | Quem conhece quem: sabe o nome e reconhece o rosto e a voz |
| `create_items` | Itens no inventário, na mão, sobre um móvel ou no chão, com modelo 3D e jeito de empunhar |
| `random` | Sorteios (intervalo, lista ou dados) |
| `skill_check` | Teste resolvido pelo motor |
| `inspect` / `recall` | Consultar detalhes e fatos fora do resumo |
| `update_character` | Aprofundar NPCs, traços, dano e cura, perks, condições, pensamentos e a pose do corpo |
| `move_character` | Mover por caminho, sentar, ir até alguém, trocar de local |
| `transfer_item` / `update_item` | Pegar, entregar, largar, empunhar e guardar, consumir, acender e apagar luzes |
| `update_fixture` | Escrever no quadro (aparece no 3D), abrir portas |
| `update_location` | Luz ambiente (acender ou apagar as luzes, anoitecer) e descrição do local |
| `add_fact` / `update_thread` | Memória da história |
| `share_knowledge` | Quem ficou sabendo de um fato (só quem sabe pode contar) |
| `advance_time` | Relógio |

### Ação marcada

O jogador pode marcar partes da ação com convenções de livro e de chat, ou com os botões acima
da caixa de texto (💬 Falar, 🤫 Sussurrar, 💭 Pensar, ✋ Agir). Enquanto digita, uma prévia mostra
como o mestre vai entender cada parte.

| Escreva | Vira | O que o motor faz |
|---|---|---|
| `"Bom dia, turma."` ou `— Bom dia, turma.` | fala | entra na narração como fala dele, com as palavras dele |
| `@Mei "me encontra no intervalo"` | sussurro | só a Mei ouve (alcance do cochicho; se ela está longe, o mestre leva o personagem até ela) |
| `(será que ela sabe?)` | pensamento | vira o pensamento atual do personagem; só quem percebe mentes fica sabendo |
| `*abro a janela*` | ação | o que ele tenta fazer |

Texto sem marca continua valendo como ação ou intenção. O botão de sussurro lista quem está no
local, do mais perto ao mais longe, e o inspetor de um personagem tem "Sussurrar para…". O mestre
recebe a ação como o jogador escreveu e, logo abaixo, as partes separadas; o verificador aponta
NPC que reage a um pensamento que não poderia perceber.

### Replay com balões de fala

Cada turno é um frame. O mestre escreve cada fala numa linha própria, `@id: fala`
(gestos curtos entre asteriscos; modos e alvos na seção seguinte). No 3D, cada fala vira um
balão sobre quem fala, com até três na tela, os mais antigos esmaecendo, e a narração vira
legenda. Os gestos marcados (`{id:gesto}`, em "Corpo, armas e gestos") acontecem no passo em
que aparecem. O balão do cochicho é tracejado e o do grito, em negrito. No fim de cada turno o
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

### Luz e visão

A luz é calculada por tile: a luz ambiente do local (de 0, breu, a 1, dia claro ou luzes
acesas) ou a luz mais forte que chega até ali, de itens acesos (lanterna, vela, tocha) ou de
personagens que emitem luz por um poder. O que cada personagem enxerga de outro sai da luz no
alvo, da distância e da visão dele: nítido, só um vulto, ou nada.

| Situação | O que o motor faz |
|---|---|
| Luzes apagadas | `update_location` com `light` baixo; quem não tem luz não vê ninguém |
| Lanterna | item com `light` (`radius`, `intensity`), acesa com `update_item` (`light_on`); ilumina em volta de quem carrega |
| Poder de luz | perk com `{ "kind": "light", "radius": 4 }`: o personagem brilha |
| Experimento que dá errado | condição `cego` ou `visao_turva` (`update_character` com `conditions_add`, e `minutes` se passa sozinha) |
| Visão no escuro | perk `{ "kind": "sense", "channel": "visao", "bonus": 6 }`: enxerga sem luz até 6 tiles |

Condições são como perks que vêm e vão: `cego`, `visao_turva`, `ofuscado` e `surdo` vêm
prontas, e o mestre cria outras com `extend_ruleset`. Elas multiplicam o alcance de um sentido
(`factor`: 0 apaga, 0,5 turva) e acabam sozinhas quando o relógio passa do prazo. Ler lábios
exige enxergar quem fala, e um `skill_check` contra quem o personagem não vê bem perde 1 (vulto)
ou 3 (nada), salvo ações que não dependem de ver (`needs_sight: false`).

No 3D, a luz ambiente controla a iluminação da cena, cada luz acesa vira um ponto de luz que
acompanha quem a carrega, e quem o jogador não vê fica sem nome (vulto vira "?"). Quando a visão
do próprio jogador falha, o palco escurece, borra e fecha nas bordas, sem chegar ao preto. O
resumo do turno diz ao mestre a luz, as condições e quem o jogador não vê, e o verificador
aponta narração que descreve o que ele não poderia enxergar.

Na demo offline dá para testar sem gastar tokens: "Apago a luz e pego a lanterna", "Faço o
experimento de química" e "Acendo a luz". "Tiro uma bomba de fedor do bolso" mostra o motor
barrando um item que o jogador não tem.

### Conhecidos

O motor guarda um grafo de quem conhece quem (`Character.knows`). Conhecer é saber o nome e
reconhecer o rosto e a voz. Na criação, o mestre registra com `introduce` quem já se conhecia
(`group` para todos com todos; `who` + `knows` para pares, com `mutual: false` quando só um lado
conhece). No jogo, ele chama `introduce` quando alguém se apresenta ou é apresentado.

O jogador sabe quem é alguém quando o conhece e o vê com nitidez, ou quando o conhece e o ouviu
falar ali (`Character.voices`, que se apaga quando um dos dois muda de local). Fora disso:

| Situação | No chat, nos chips e no 3D |
|---|---|
| Estranho visto com clareza | a descrição que o mestre deu (`seen_as`): "o homem de terno" |
| Estranho no escuro que fala | "uma voz de homem" (ou de mulher, pelo corpo) |
| Conhecido no escuro que fala | o nome: ele reconhece a voz, e o clique diz isso |
| Conhecido no escuro que não falou | "?", e "Um vulto" no clique |
| Quem o jogador nem vê nem ouve | nada; até o gesto de um cochicho some |

A troca acontece no servidor, em notas da linha de fala (`@otavio[fala|como uma voz de
homem]: …`), então o chat também não pinta a fala com a cor do personagem. Para sussurrar a um
estranho, o jogador usa a descrição: `@[o homem de terno] "…"`. O resumo do turno diz ao mestre
quem o jogador conhece e como o identifica agora, e o verificador aponta narração que chama pelo
nome quem ele não conhece ou não identifica. Saves de antes do grafo carregam com todos se
conhecendo, como era, e com as vozes da última narração.

### Modelos 3D (Synty)

O palco usa modelos low-poly da Synty (pacotes POLYGON e de animação) quando eles estão
convertidos. Sem eles, segue com as primitivas, então o projeto roda em qualquer máquina.

1. Baixe os "SourceFiles" de cada pacote na biblioteca da Synty e extraia com
   `python3 -I scripts/assets/unpack_synty.py --delete ~/Downloads/POLYGON_*_SourceFiles_*.zip`.
   Ele guarda só FBX, texturas e a lista de materiais em `assets/synty/<pacote>/` (por exemplo
   `assets/synty/town/`, `assets/synty/anim_base_locomotion/`) e apaga o zip. A pasta fica fora
   do git: a licença não permite compartilhar os arquivos-fonte fora da equipe.
2. `python3 -I scripts/assets/index_synty.py` monta o repertório: `assets/synty/repertorio.json`,
   com um item por modelo (pacote, categoria e palavras do nome), e `assets/synty/REPERTORIO.md`,
   o resumo. As categorias são personagem, animal, objeto, construção, ambiente, veículo, arma,
   acessório, animação e efeito. Ele lê os nomes dos arquivos e, quando há, as descrições do
   catálogo visual (abaixo), e o resultado é só texto.
3. Rode `npm run assets` (precisa do Blender 4.2 ou mais novo no PATH) para converter os modelos
   que o catálogo usa. O resultado vai para `public/models/`, também fora do git.

O que entra está em [scripts/assets/synty.json](scripts/assets/synty.json):

- **Móveis:** cada tipo da legenda do motor (carteira, mesa do professor, estante, armário…) é
  montado com peças do catálogo. A carteira, por exemplo, é a mesa infantil mais a cadeira
  atrás. `seats` diz onde fica o quadril de quem senta em cada tipo (no sofá, mais à frente,
  para as pernas descerem na frente da base). Lousa, janela, porta, elevador e escada seguem
  primitivas, porque fazem parte da parede e a lousa mostra o texto do jogo.
- **Personagens:** adultos e adolescentes dos pacotes City e Town, cada um com uma descrição
  do visual (`look`). O prompt do mestre recebe a lista, e ele escolhe o `look` de cada
  personagem e escreve a aparência a partir dele, então o card e o 3D descrevem a mesma
  pessoa. Sem `look` (campanhas antigas), a interface usa `figure` (adulto, adulta, menino,
  menina) ou deduz o corpo pelo papel e pela aparência. A cor é sempre a variante principal,
  a que as descrições retratam.
- **Animações:** a tabela `clips` (cerca de 110: andar, poses, gestos, golpes, tiros) aponta
  cada clipe para um arquivo dos pacotes de animação. Os personagens antigos da Synty e os
  pacotes de animação usam nomes de ossos diferentes, e os arquivos de animação têm outra pose
  de repouso. Por isso o conversor renomeia os ossos e transfere a rotação de cada um em espaço
  de mundo, tendo a pose em T como referência comum. Cada clipe vira um GLB por sexo
  (`public/models/anims/<sexo>/<clipe>.glb`, uns 90 KB), que o 3D carrega quando a cena pede,
  e serve para todos os personagens com o mesmo esqueleto. Algumas poses são montadas pelo
  conversor (sentar, sentar no chão, deitar, mãos ao alto, o coice do tiro), e
  `npm run assets -- anims` (ou o 4º argumento do script) refaz só as animações.

Cada móvel pesa de 6 a 215 KB, cada personagem cerca de 300 KB, e a cor vem de uma
textura-paleta por pacote, baixada uma vez só. O mestre só conhece os modelos por texto (o corpo
dos personagens). Modelos e imagens da cena nunca vão para o modelo de IA.

#### Catálogo visual e modelos sob demanda

Todos os modelos do repertório (fora as animações) foram descritos olhando: o
`scripts/assets/thumbs_synty.py` renderiza uma miniatura de cada um, o `sheets_synty.py` junta as
miniaturas em grades, e as descrições ficam em `assets/synty/_catalogo/descricoes/`. Cada uma diz
o que o modelo é, a categoria e, para personagens e animais, o corpo e o visual. A marca
`sensivel` (símbolo de ódio ou conteúdo sexual) tira o modelo das buscas. O `index_synty.py` junta
tudo no repertório.

- **Busca do mestre:** a tool `search_models` procura no catálogo pela descrição ("sofá de couro
  marrom", "policial de quepe"). Um tipo novo da legenda pode ter o visual de qualquer modelo
  (`{"label": "mesa de sinuca", "like": "table", "model": "casino:SM_Prop_Pool_Table_01"}`), e o
  `look` de um personagem pode ser qualquer personagem do catálogo. O motor confere o id e, no
  personagem, pega o corpo do modelo.
- **Conversão sob demanda:** quando o 3D pede um modelo do catálogo, o servidor roda o Blender
  (`scripts/assets/convert_model.py`, ou o executável de `CRPS_BLENDER`) e guarda o GLB, a ficha e
  as texturas em `public/models/cache/`, fora do git. Leva alguns segundos na primeira vez.
  - O GLB tem só a geometria. Cada textura vira um PNG de até 2048 px, compartilhado entre os
    modelos.
  - Os materiais seguem as mesmas regras das miniaturas (`synty_blender.py`), para o jogo mostrar o
    que o catálogo descreve: textura por material, recorte nas folhas e grades, tom nas folhas
    cinzentas e tronco separado da folha.
  - Sem Blender ou sem o repertório, o 3D usa o parecido do tipo ou o corpo do personagem.
- **Limites:**
  - Personagens exportados para o Unreal (pastas `Unreal_Characters`) usam outro esqueleto e ficam
    fora: a versão padrão do mesmo personagem costuma existir.
  - Arquivos com várias variantes no mesmo lugar (as pelagens do cavalo) mostram só a primeira.
  - Os pacotes "simple" vêm em miniatura, então um bicho bem menor que o espaço que o mestre deu
    cresce até ocupá-lo.

### Corpo, armas e gestos

O corpo de cada personagem no 3D segue o motor, em três camadas descritas como dados em
[src/engine/body.ts](src/engine/body.ts):

- **Pose** é o estado do corpo e fica até mudar: ajoelhado, agachado, mãos ao alto, braços
  cruzados, encostado, ao telefone, bêbado, em guarda, mirando… O mestre muda com
  `update_character` (`pose`, e `pose_target` para mirar ou apontar para alguém ou algo, em
  qualquer ângulo). Andar desfaz a pose. Sentar e deitar vêm do assento e da cama, e quem fica
  com a vida em 0 cai sozinho (o 3D toca a queda). O retrato do turno guarda a pose, então o
  replay mostra o corpo como estava.
- **Item na mão:** empunhar é `transfer_item` para `{character_id, hand}`, e guardar é mandar de
  volta sem `hand`. O item tem `model` (do catálogo) e `grip`, o jeito de empunhar: pistola,
  arma longa, arco, uma mão, duas mãos, escudo ou objeto. O arco e o escudo vão na esquerda,
  e fuzil e lança ocupam as duas mãos; o que estava na mão volta a ficar guardado. A pose usa o
  clipe da arma: "mirando" com pistola estica o braço, com fuzil leva a arma ao rosto, com arco
  puxa a corda.
- **Gesto** é de um instante e vai na narração, na frase em que acontece: `{id:gesto}` ou
  `{id:gesto>alvo}` (aceno, reverência, continência, aplauso, birra, golpe, tiro, esquiva…).
  - O motor confere: o gesto existe (sinônimos e infinitivos viram o da tabela, como
    `atira` → `ataca`), o alvo está no local e um ataque de perto alcança o alvo. De longe, só com
    arma de alcance na mão.
  - `ataca` toca o golpe da arma na mão: soco, espada, tiro ou flecha. O tiro tem clarão no cano
    e rastro até o alvo.
  - A interface tira as marcas do texto, e a versão do jogador some com os gestos de quem ele
    não vê.
  - Sentado ou ajoelhado, o gesto mexe só o tronco e os braços.

A biblioteca da Synty não tem animação de arma de fogo. A pistola mira com o braço do clipe de
apontar, o fuzil mira com a pose do arco (a coronha no ombro, a mão de apoio no guarda-mão) e
descansa atravessado no peito.

O item na mão é a conversão `held` do mesmo modelo, com a origem no punho e o cano em +z ou a
lâmina em +y, como as armas da Synty vêm. A cada quadro, o 3D o encaixa pela posição do pulso e
das juntas do indicador e do médio, o que não depende de como cada esqueleto orienta os ossos.
Haste com o punho no meio (lança, cajado, tocha) é segurada perto da ponta de baixo, e lança ou
cajado em descanso fica em pé, apoiado no chão.

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

### Objetos como dado

Os tipos de objeto são dados (`src/engine/objects.ts`), como as regras. Cada tipo diz:
- se é assento, cama, mesa ou superfície (e a altura em que os itens ficam apoiados);
- se fica na parede, se dá para andar por cima e se é saída (para um lugar só ou para qualquer andar);
- como se orienta no layout (para dentro da sala, para o lado livre, no comprimento…);
- o tamanho típico em tiles, a altura, a cor e o artigo.

Os 16 tipos de sempre têm caractere fixo na legenda. A biblioteca traz mais de 60, de casa, escritório, loja, museu, hospital,
ficção científica, fantasia e ao ar livre. Eles entram num local pela legenda dele:

```json
{ "layout": ["####QQ####", "#.VVV....D", "#........#", "##########"],
  "legend": { "Q": "painting", "V": "vitrine", "H": { "label": "escotilha de serviço", "like": "hatch" } } }
```

Cada caractere aponta para um tipo da biblioteca, pelo id ou pelo nome, ou define um tipo novo. O
tipo novo herda do parecido (`like`) o que não for informado, inclusive o visual, e fica salvo na
campanha (`WorldState.objectTypes`) para os outros locais. No 3D, o tipo usa os modelos do
catálogo (`fixtures` em `synty.json`, com variantes escolhidas pelo id do objeto). Sem modelo, ele
usa os do tipo parecido e, por fim, uma primitiva com a cor e a altura do tipo.

### Saídas e andares

Porta `D`, elevador `E` e escada `Z` ficam na parede e são as saídas do local. Cada uma tem
um nome e a lista de lugares para onde leva (`Location.exits`), e o resumo do turno mostra as
duas coisas ao mestre. Mudar de local é passar por uma saída: `move_character` com
`location_id` e `via`. O motor confere se há caminho até a saída e põe quem chega junto da
saída que leva de volta. Na primeira passagem, ele liga os dois lados.

A porta leva a um lugar só: o motor recusa usar a porta da rua para chegar ao 11º andar. O
elevador e a escada levam a qualquer andar, e cada andar é um local. Quem sobe de elevador
sai do elevador, e quem sobe de escada sai da escada. Local sem saída nenhuma (área aberta)
continua permitindo chegar e sair de qualquer ponto.

Para prédios, o mestre não precisa desenhar: `create_location` com `template` gera layouts
coerentes, espelhados ao acaso:

- `saguao`: porta dupla para a rua, portaria com balcão e cadeira de frente para a entrada,
  dois elevadores (A e B) e a escada no fundo, estante, sofá e plantas.
- `corredor` com `floor`: elevador numa ponta, escada na outra e as portas numeradas pelo
  andar (no 11º, Apto 1101, 1102…).

No 3D, cada saída ganha uma placa com o nome. Clicar nela abre o inspetor, com o texto pronto
para passar pela porta, pegar o elevador ou usar a escada.

## Próximos passos

- Trocar as primitivas por assets low-poly CC0 (Kenney, KayKit, Quaternius).
- Agenda dos NPCs e eventos disparados pelo relógio (o sinal da escola, o intervalo).
- Mais layouts prontos (apartamento, loja, escritório) e gerar o local vizinho sob demanda.
- Avaliação automática do mestre: roteiros de jogador e checagem de consistência ao longo de muitos turnos.
