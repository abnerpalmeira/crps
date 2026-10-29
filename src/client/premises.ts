/**
 * Premissas sorteadas para o botão de dado do "Qual história você quer viver?": gênero, quem o
 * jogador é e onde, e um gancho para a primeira cena. Tudo local, sem gastar o modelo.
 */
const GENRES = ['Um slice of life', 'Um mistério', 'Uma comédia', 'Um drama', 'Um suspense', 'Uma aventura'];

/** Quem o jogador é e onde, nas formas masculina e feminina. */
const SITUATIONS: [string, string][] = [
  ['um professor de química numa escola de ensino médio', 'uma professora de química numa escola de ensino médio'],
  ['o gerente de um hotel cinco estrelas em Lisboa', 'a gerente de um hotel cinco estrelas em Lisboa'],
  ['um enfermeiro do plantão noturno num hospital do interior', 'uma enfermeira do plantão noturno num hospital do interior'],
  ['o síndico de um prédio antigo em São Paulo', 'a síndica de um prédio antigo em São Paulo'],
  ['o chef de um restaurante disputado em Tóquio', 'a chef de um restaurante disputado em Tóquio'],
  ['um estagiário numa startup prestes a falir', 'uma estagiária numa startup prestes a falir'],
  ['um aluno novo num colégio interno nas montanhas', 'uma aluna nova num colégio interno nas montanhas'],
  ['o guia de um navio de cruzeiro no Caribe', 'a guia de um navio de cruzeiro no Caribe'],
  ['o bibliotecário de uma biblioteca centenária', 'a bibliotecária de uma biblioteca centenária'],
  ['um técnico de manutenção numa estação espacial', 'uma técnica de manutenção numa estação espacial'],
  ['um detetive recém-transferido para uma cidade pequena', 'uma detetive recém-transferida para uma cidade pequena'],
  ['o palestrante de um evento fechado para trinta bilionários', 'a palestrante de um evento fechado para trinta bilionários'],
  ['um entregador de aplicativo numa cidade grande', 'uma entregadora de aplicativo numa cidade grande'],
  ['o vigia noturno de um museu', 'a vigia noturna de um museu'],
  ['o dono de uma loja de antiguidades', 'a dona de uma loja de antiguidades'],
  ['um aprendiz de mago numa torre de magia', 'uma aprendiz de maga numa torre de magia'],
];

const HOOKS = [
  'e alguém deixou um bilhete anônimo na minha mesa',
  'e a luz acaba no meio do expediente',
  'e um colega some sem deixar rastro',
  'e hoje chega uma inspeção surpresa',
  'e acabo de descobrir um segredo que ninguém pode saber',
  'e uma tempestade deixa todo mundo preso lá dentro',
  'e um visitante misterioso pergunta por mim',
  'e um objeto valioso desaparece bem na minha frente',
  'e alguém começa a espalhar boatos sobre mim',
  'e é o meu primeiro dia',
  'e preciso resolver tudo antes do fim do dia',
];

const pick = <T>(list: T[], random: () => number): T => list[Math.floor(random() * list.length)];

/** Uma premissa nova; `previous` evita repetir a mesma ao rolar de novo. */
export function randomPremise(random: () => number = Math.random, previous = ''): string {
  for (let attempt = 0; ; attempt++) {
    const situation = pick(SITUATIONS, random)[random() < 0.5 ? 0 : 1];
    const premise = `${pick(GENRES, random)} em que eu sou ${situation} ${pick(HOOKS, random)}.`;
    if (premise !== previous || attempt >= 5) return premise;
  }
}
