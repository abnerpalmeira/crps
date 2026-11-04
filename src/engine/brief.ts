import { POSES, bodyPose, handsOf } from './body';
import { itemPlace } from './reading';
import { DEFAULT_PER_POINT } from './effects';
import { DIFFICULTY_LABEL, VISIBILITY_LABEL, type GameEngine } from './engine';
import { DECOR, FLOOR_LABELS, WALL_MATERIALS, locationLook } from './eras';
import { LEGEND } from './layout';
import { typeChain } from './objects';
import { lightAt, lightLabel, lightSources } from './light';
import { FEELING_LABELS, feelingsHere, perceives, perceptionOf, strangerLabel, visionOf, type Perception } from './perception';
import { formatClock, formatDuration, signed, truncate } from './text';
import type { Character, DifficultyName, Location, PerkDef, ReadyLine, Visibility } from './types';

const MARKERS = '123456789AEFGHIJKLMNOPQRUVXYZ'.split('');

/** Mapa ASCII com régua de colunas, números de linha e personagens marcados. */
export function renderMap(engine: GameEngine, loc: Location): { map: string; markers: Map<string, string> } {
  const grid = loc.tiles.map((row) => [...row]);
  const markers = new Map<string, string>();
  let n = 0;
  for (const c of engine.charactersIn(loc.id)) {
    if (!c.pos) continue;
    const mark = c.isPlayer ? '@' : (MARKERS[n++] ?? '*');
    markers.set(c.id, mark);
    grid[c.pos.y][c.pos.x] = mark;
  }
  const pad = String(loc.height - 1).length + 1;
  const cols = Array.from({ length: loc.width }, (_, x) => x);
  const tens = loc.width > 10 ? ' '.repeat(pad) + cols.map((x) => (x > 0 && x % 10 === 0 ? String(x / 10) : ' ')).join('') : null;
  const units = ' '.repeat(pad) + cols.map((x) => String(x % 10)).join('');
  const rows = grid.map((row, y) => `${String(y).padStart(pad - 1)} ${row.join('')}`);
  return { map: [tens, units, ...rows].filter((l) => l !== null).join('\n'), markers };
}

/** Se o jogador sabe quem é: estranho para ele, conhecido que ele só reconhece pela voz, ou que ele não identifica agora. */
function identity(view: Perception, c: Character, hasPlayer: boolean): string {
  if (!hasPlayer || c.isPlayer) return '';
  if (!view.knows(c.id)) return `; o jogador NÃO conhece: para ele é "${strangerLabel(c)}"`;
  const how = view.recognize(c.id);
  return how === 'voz' ? '; o jogador reconhece pela voz' : how ? '' : '; o jogador conhece, mas não sabe que é ele(a)';
}

/** Quem, dos presentes, o personagem conhece. */
function acquaintances(c: Character, present: Character[]): string {
  const others = present.filter((o) => o.id !== c.id);
  if (!others.length) return '';
  const known = others.filter((o) => c.knows.includes(o.id));
  if (known.length === others.length) return '; conhece todos aqui';
  return known.length ? `; conhece aqui: ${known.map((o) => o.name.split(' ')[0]).join(', ')}` : '; não conhece ninguém aqui';
}

/**
 * O que o NPC sente por quem está aqui, se o jogador percebe (lendo a mente dele) e por quem ainda
 * falta registrar: toda reação parte do sentimento, então o mestre precisa ver o buraco.
 */
function feelingsLine(engine: GameEngine, view: Perception, c: Character, present: Character[]): string {
  const here = feelingsHere(engine.state, c);
  const list = here.map(
    ({ target, feeling }) =>
      `por ${target.name.split(' ')[0]} ${signed(feeling.degree)} (${FEELING_LABELS[feeling.degree]}${feeling.text ? `: "${truncate(feeling.text, 100)}"` : ''})`,
  );
  const feels = list.length ? `; sente${view.canSeeThoughts(c.id) ? ' (o jogador percebe)' : ''}: ${list.join(', ')}` : '';
  const others = present.filter((o) => o.id !== c.id);
  const missing = others.filter((o) => !c.feelings[o.id]);
  if (!missing.length) return feels;
  if (missing.length === others.length && others.length > 1) return `${feels}; falta sentimento por todos aqui`;
  const names = missing.slice(0, 4).map((o) => o.name.split(' ')[0]).join(', ');
  return `${feels}; falta sentimento por: ${names}${missing.length > 4 ? ` e mais ${missing.length - 4}` : ''}`;
}

/** Como o lugar se parece no 3D, para a narração bater com o que o jogador vê. */
function lookLine(loc: Location): string {
  const floor = `chão de ${FLOOR_LABELS[loc.floor] ?? loc.floor}`;
  if (loc.outdoor) return floor;
  const look = locationLook(loc);
  const material = WALL_MATERIALS.find((m) => m.id === look.walls?.material)?.label ?? 'reboco claro';
  const walls = `paredes de ${material}${look.walls?.color ? ` (${look.walls.color})` : ''}`;
  const decor = look.decor.map((id) => DECOR.find((d) => d.id === id)?.label ?? id);
  return `${walls}, ${floor}; ${decor.length ? `nas paredes: ${decor.join(', ')}` : 'paredes nuas'}`;
}

function shortId(loc: Location, id: string): string {
  return id.startsWith(`${loc.id}/`) ? id.slice(loc.id.length + 1) : id;
}

export function describePerk(perk: PerkDef): string {
  const effects = perk.grants.map((g) => {
    if (g.kind === 'see_stat') return `vê ${g.stat} de todos`;
    if (g.kind === 'see_thoughts') return 'percebe o que os outros pensam';
    if (g.kind === 'light') return `emite luz (raio ${g.radius})`;
    if (g.kind === 'conjure') {
      return `tira itens do nada${g.note ? `: ${g.note}` : ''}${g.cost ? `, custa ${g.cost.amount} de ${g.cost.resource}` : ''}`;
    }
    if (g.kind === 'sense') {
      const mult = g.multiplier !== undefined ? ` ×${g.multiplier}` : '';
      const bonus = g.bonus ? ` ${g.bonus > 0 ? '+' : ''}${g.bonus} tiles` : '';
      const factor = g.factor === undefined ? '' : g.factor === 0 ? ' anulado' : ` fator ${g.factor}`;
      return `sentido ${g.channel}${mult}${bonus}${factor}`;
    }
    if (g.kind === 'move') {
      const bonus = g.bonus ? `${g.bonus > 0 ? '+' : ''}${g.bonus} passos` : '';
      const factor = g.factor === undefined ? '' : g.factor === 0 ? 'não anda' : `passos ×${g.factor}`;
      return [bonus, factor].filter(Boolean).join(', ');
    }
    const scope = [g.attribute && `de ${g.attribute}`, g.skill && `com ${g.skill}`].filter(Boolean).join(' ');
    return `${g.bonus > 0 ? '+' : ''}${g.bonus} em testes${scope ? ` ${scope}` : ''}`;
  });
  return effects.join(', ') || perk.description;
}

function statLine(values: Record<string, number>): string {
  const entries = Object.entries(values);
  return entries.length ? entries.map(([k, v]) => `${k} ${v}`).join(', ') : '—';
}

function resourceLine(engine: GameEngine, c: Character, onlyChanged: boolean): string {
  return engine.state.ruleset.resources
    .filter((r) => !onlyChanged || (c.resources[r.id] ?? r.max) !== r.max)
    .map((r) => `${r.id} ${c.resources[r.id] ?? r.max}/${r.max}`)
    .join(', ');
}

export interface BriefOptions {
  recentTurns?: number;
  maxFacts?: number;
}

/**
 * Contexto do turno compilado a partir do estado. O modelo não carrega o
 * histórico da campanha: recebe isto, que tem tamanho estável na hora 1 e na hora 80.
 */
export function compileBrief(engine: GameEngine, opts: BriefOptions = {}): string {
  const { recentTurns = 4, maxFacts = 25 } = opts;
  const s = engine.state;
  const rules = s.ruleset;
  const out: string[] = [];

  const diffs = (Object.keys(rules.difficulties) as DifficultyName[])
    .map((d) => `${DIFFICULTY_LABEL[d]} ${rules.difficulties[d]}`)
    .join(', ');
  out.push('# ESTADO DO MUNDO (compilado pelo motor; é a fonte da verdade)');
  out.push(`Turno ${s.turn} · ${formatClock(s.clock)}`);
  out.push(`Premissa: ${s.premise}`);
  const vis = (v: Visibility) => (v === 'self' ? '' : `, ${VISIBILITY_LABEL[v]}`);
  out.push(
    `Regras "${rules.name}": teste = ${rules.dice} + atributo + perícia (+ modificador + perks) ≥ dificuldade (${diffs}). ` +
      `Atributos: ${rules.attributes.map((a) => `${a.id} (${a.name}${vis(a.visibility)})`).join(', ')}. ` +
      `Recursos: ${rules.resources.map((r) => `${r.id} (máx ${r.max}${vis(r.visibility)}${r.core ? ', universal' : ''})`).join(', ') || 'nenhum'}. ` +
      `${rules.notes}`,
  );
  const move = rules.movement;
  const time = rules.time;
  const verbs = Object.entries(time.verbs ?? {}).map(([v, n]) => `, ${v} ${n} s`).join('');
  out.push(
    `Tempo do turno: o jogador age no grid sem você pelo tempo que você der (set_turn_time), e cada ação gasta dele: andar ` +
      `${move.speed} casa(s) por segundo${move.attribute ? ` (+${move.perPoint ?? DEFAULT_PER_POINT} por ponto de ${move.attribute})` : ''}, ` +
      `ouvir uma fala ${time.talk} s, cada ação do menu ${time.act} s${verbs}. Perks e condições com move somam ou multiplicam a velocidade.`,
  );
  if (rules.perks.length) out.push(`Perks: ${rules.perks.map((perk) => `${perk.id} (${perk.name}: ${describePerk(perk)})`).join('; ')}.`);
  if (rules.conditions.length) out.push(`Condições: ${rules.conditions.map((d) => `${d.id} (${describePerk(d)})`).join('; ')}.`);

  const loc = engine.currentLocation;
  const sceneIds = new Set<string>();
  if (!loc) {
    out.push('\n(Nenhum local criado ainda.)');
  } else {
    sceneIds.add(loc.id);
    const { map, markers } = renderMap(engine, loc);
    out.push(`\n## Local atual: ${loc.name} [${loc.id}], ${loc.width}×${loc.height}, ${loc.outdoor ? 'área aberta' : 'interior'}`);
    if (loc.description) out.push(loc.description);
    out.push(`Aparência: ${lookLine(loc)}.`);
    out.push('```', map, '```');
    const used = [...new Set(loc.tiles.join(''))].map((ch) => LEGEND[ch] ?? loc.legend?.[ch]).filter((d) => d && d.char !== ' ');
    out.push(
      `Legenda: ${used.map((d) => `'${d.char}' ${d.label}`).join(', ')}; '@' você; outros marcadores = personagens listados abaixo. ` +
        `x = coluna, y = linha. Ids de móveis começam com "${loc.id}/".`,
    );
    const sources = lightSources(s, loc.id);
    const lit = sources.map((src) => {
      const carrier = src.carrierId ? s.characters[src.carrierId]?.name : null;
      if (src.kind === 'character') return `${src.name} emite luz (raio ${src.radius})`;
      return `${src.name} [${src.id}] ${carrier ? `com ${carrier}` : `em (${src.pos.x},${src.pos.y})`} (raio ${src.radius})`;
    });
    out.push(`Luz: ${lightLabel(loc.light)} (ambiente ${loc.light})${lit.length ? `; acesas: ${lit.join(', ')}` : ''}.`);
    const exits = Object.entries(loc.exits ?? {}).map(([id, e]) => {
      const to = e.to.length ? `→ ${e.to.map((id) => `${s.locations[id]?.name ?? id} [${id}]`).join(', ')}` : 'sem destino ainda';
      return `${shortId(loc, id)} (${e.label}, ${to})`;
    });
    out.push(`Saídas: ${exits.join('; ') || 'nenhuma'}.`);

    const lines: string[] = [];
    const seatGroups = new Map<string, { free: string[]; total: number }>();
    for (const f of loc.fixtures) {
      if (f.seat && !f.text && !f.state) {
        const group = seatGroups.get(f.label) ?? { free: [], total: 0 };
        group.total++;
        if (!engine.charactersIn(loc.id).some((c) => c.seatId === f.id)) group.free.push(shortId(loc, f.id));
        seatGroups.set(f.label, group);
        continue;
      }
      const size = f.w > 1 || f.h > 1 ? ` ${f.w}×${f.h}` : '';
      const on = engine.itemsOn(f.id).map((i) => `${i.name} [${i.id}]`);
      lines.push(
        `- ${shortId(loc, f.id)}: ${f.label} (${f.x},${f.y})${size}, frente ${f.facing}` +
          (f.text ? `, escrito: "${truncate(f.text, 240)}"` : '') +
          (f.state ? ` [${f.state}]` : '') +
          (on.length ? `; sobre ele: ${on.join(', ')}` : ''),
      );
      for (const i of engine.itemsOn(f.id)) sceneIds.add(i.id);
    }
    for (const [label, g] of seatGroups) {
      lines.push(`- ${label}: ${g.total} no total, livres: ${g.free.join(', ') || 'nenhuma'}`);
    }
    for (const f of loc.fixtures.filter((f) => f.seat)) {
      for (const i of engine.itemsOn(f.id)) {
        lines.push(`- ${i.name} [${i.id}] sobre ${shortId(loc, f.id)}`);
        sceneIds.add(i.id);
      }
    }
    out.push(`\nMóveis:\n${lines.join('\n') || '(nenhum)'}`);

    const view = perceptionOf(s, s.playerId);
    const present = engine.charactersIn(loc.id);
    const people = present.map((c) => {
      sceneIds.add(c.id);
      const mind = c.thoughts ? `; pensa${view.canSeeThoughts(c.id) ? ' (o jogador percebe)' : ''}: "${truncate(c.thoughts, 160)}"` : '';
      // O jeito e o que o NPC quer guiam como ele reage em cena (o personagem do jogador, quem decide é o jogador).
      const manner = !c.isPlayer && c.personality ? `; jeito: "${truncate(c.personality, 140)}"` : '';
      const wants = !c.isPlayer && c.goals ? `; quer: "${truncate(c.goals, 120)}"` : '';
      const feels = c.isPlayer ? '' : feelingsLine(engine, view, c, present);
      const conditions = engine.conditionLabels(c);
      const light = c.pos ? lightLabel(lightAt(s, loc.id, c.pos, sources)) : 'claro';
      const sight = c.isPlayer || !s.playerId ? 'nitido' : view.sight(c.id);
      const senses =
        (conditions.length ? `; condições: ${conditions.join(', ')}` : '') +
        (light !== 'claro' ? `; luz: ${light}` : '') +
        (sight === 'vulto' ? '; o jogador vê só um vulto' : sight === 'nada' ? '; o jogador NÃO vê' : '') +
        identity(view, c, Boolean(s.playerId)) +
        acquaintances(c, present);
      const pose = bodyPose(s, c);
      const aim = c.poseTarget ? ` (${c.poseTarget.includes('/') ? shortId(loc, c.poseTarget) : c.poseTarget})` : '';
      const seat = c.seatId ? loc.fixtures.find((f) => f.id === c.seatId) : undefined;
      const onBed = seat ? typeChain(s, seat.kind).some((t) => t.bed) : false;
      const where = c.seatId
        ? `${pose === 'deitado' ? 'deitado(a) em' : onBed ? 'sentado(a) na beirada de' : 'sentado(a) em'} ${shortId(loc, c.seatId)}`
        : `${pose === 'sentado' ? 'sentado(a) no chão' : POSES[pose].label}${aim}`;
      const hands = handsOf(s, c.id);
      const held = [...new Set([hands.direita, hands.esquerda])].filter((i) => i !== null);
      const holding = held.length ? `; na mão: ${held.map((i) => `${i.name} [${i.id}]`).join(', ')}` : '';
      const res = resourceLine(engine, c, !c.isPlayer);
      const perks = engine.perksOf(c).map((perk) => perk.name);
      return (
        `- ${markers.get(c.id) ?? '?'} ${c.name} [${c.id}]${c.isPlayer ? ' (VOCÊ, jogador)' : ''}: ${c.role}; ${where} (${c.pos?.x},${c.pos?.y}), olhando ${c.facing}${holding}; ` +
        `${c.detail === 'sketch' ? 'esboço' : 'completo'}; traços: ${c.traits.join(', ') || '—'}${res ? `; ${res}` : ''}` +
        `${perks.length ? `; perks: ${perks.join(', ')}` : ''}${senses}${manner}${mind}${feels}${wants}${c.isPlayer ? '' : linesNote(c)}`
      );
    });
    out.push(`\nPersonagens aqui:\n${people.join('\n') || '(ninguém)'}`);

    const ground = engine.itemsOnGround(loc.id);
    if (ground.length) {
      out.push(`Itens no chão: ${ground.map((i) => `${i.name} [${i.id}] (${i.holder.kind === 'ground' ? `${i.holder.x},${i.holder.y}` : ''})`).join(', ')}`);
      for (const i of ground) sceneIds.add(i.id);
    }
    // O que está escrito nos itens em cena e quem já sabe: toda leitura repete esse texto.
    const texts = Object.values(s.items).filter((i) => i.text !== undefined && itemPlace(s, i)?.locationId === loc.id);
    if (texts.length) {
      const known = (i: (typeof texts)[number]) => {
        const fact = s.facts.find((f) => f.id === i.textFact);
        return !fact ? '' : fact.knownBy === 'all' ? 'todos' : fact.knownBy.map((id) => s.characters[id]?.name ?? id).join(', ');
      };
      out.push(
        `Textos aqui: ${texts
          .map((i) =>
            typeof i.text === 'string'
              ? `${i.name} [${i.id}] diz «${truncate(i.text, 400)}» (sabem: ${known(i) || 'ninguém'})`
              : `${i.name} [${i.id}] tem algo escrito que ninguém leu ainda (a primeira leitura define)`,
          )
          .join('; ')}`,
      );
    }
  }

  const p = engine.player;
  if (p) {
    sceneIds.add(p.id);
    const inv = engine.itemsHeldBy(p.id);
    for (const i of inv) sceneIds.add(i.id);
    out.push(`\n## Ficha do jogador: ${p.name} [${p.id}]`);
    out.push(`${p.role}. ${p.appearance}`);
    out.push(`Atributos: ${statLine(p.attributes)}. Perícias: ${statLine(p.skills)}. Recursos: ${resourceLine(engine, p, false) || '—'}.`);
    const conjure = engine.conjurePerkOf(p);
    out.push(
      `Inventário: ${inv.map((i) => `${i.name} [${i.id}]${i.quantity > 1 ? ` ×${i.quantity}` : ''}${i.holder.kind === 'character' && i.holder.hand ? ` (na mão ${i.holder.hand})` : ''}`).join(', ') || 'vazio'}. ` +
        `É tudo o que ele tem: nada surge com ele${conjure ? `, salvo pelo perk ${conjure.name} (${describePerk(conjure)})` : ''}.`,
    );
    const perks = engine.perksOf(p);
    out.push(
      `Perks: ${perks.map((perk) => `${perk.name} (${describePerk(perk)})`).join('; ') || 'nenhum'}. ` +
        'O jogador só percebe os valores ocultos que os perks mostram e os pensamentos e sentimentos marcados com "(o jogador percebe)"; não revele os outros na narração.',
    );
    if (p.thoughts && p.locationId) {
      const minds = engine.charactersIn(p.locationId).filter((c) => !c.isPlayer && perceives(s, c.id, p.id, 'mente', 0));
      out.push(
        `Pensamento dele agora: "${truncate(p.thoughts, 200)}". ` +
          (minds.length ? `Percebem: ${minds.map((c) => c.name).join(', ')}.` : 'Ninguém percebe; nenhum NPC reage a isso.'),
      );
    }
    const { acuity, darkvision } = visionOf(s, p.id);
    const sees = acuity <= 0 && darkvision <= 0 ? 'não enxerga nada' : acuity < 1 ? `turva (acuidade ${Math.round(acuity * 100) / 100})` : 'normal';
    const here = p.locationId && p.pos ? lightLabel(lightAt(s, p.locationId, p.pos)) : null;
    out.push(
      `Visão: ${sees}${darkvision ? `, enxerga no escuro até ${darkvision} tiles` : ''}${here ? `; luz onde está: ${here}` : ''}. ` +
        `Condições: ${engine.conditionLabels(p).join(', ') || 'nenhuma'}. ` +
        'Narre só o que ele percebe: de quem ele vê como vulto, só a silhueta; de quem ele NÃO vê, nada visual (som, cheiro e toque valem). ' +
        'Chame pelo nome só quem ele conhece e identifica agora, pelo rosto ou pela voz; os outros, pelo que ele percebe.',
    );
  } else {
    out.push('\n(Ainda não há personagem do jogador.)');
  }

  const others = Object.values(s.locations).filter((l) => l.id !== loc?.id);
  if (others.length) {
    const list = others.map((l) => `${l.name} [${l.id}] (${engine.charactersIn(l.id).map((c) => c.name).join(', ') || 'vazio'})`);
    out.push(`\n## Outros locais: ${list.join('; ')}`);
  }
  const offscreen = Object.values(s.characters).filter((c) => !c.locationId);
  if (offscreen.length) out.push(`Fora de cena: ${offscreen.map((c) => `${c.name} [${c.id}], ${c.role}`).join('; ')}`);

  const open = Object.values(s.threads).filter((t) => t.status === 'open');
  out.push(`\n## Fios abertos\n${open.map((t) => `- [${t.id}] ${t.title}: ${t.description}`).join('\n') || '(nenhum)'}`);

  // Conhecimento: fatos da cena e o que cada presente sabe e NÃO sabe, para o mestre não deduzir.
  const present = loc ? engine.charactersIn(loc.id) : [];
  const presentIds = new Set(present.map((c) => c.id));
  const facts = s.facts
    .filter((f) => sceneIds.has(f.subject) || f.knownBy === 'all' || f.knownBy.some((id) => presentIds.has(id)))
    .slice(-maxFacts);
  const hidden = s.facts.length - facts.length;
  const firstName = (id: string) => s.characters[id]?.name.split(' ')[0] ?? id;
  out.push(
    `\n## Conhecimento: cada personagem só sabe os fatos marcados para ele e o que percebe agora na cena` +
      `${hidden > 0 ? ` (${hidden} outros fatos só via recall)` : ''}\n` +
      (facts
        .map((f) => `- [${f.id}] (${f.subject}) ${f.text}. ${f.knownBy === 'all' ? 'Público' : `Sabem: ${f.knownBy.map(firstName).join(', ') || 'ninguém'}`}`)
        .join('\n') || '(nenhum fato registrado)'),
  );
  const restricted = facts.filter((f) => f.knownBy !== 'all');
  if (restricted.length && present.length) {
    out.push('Por personagem presente, entre os fatos restritos:');
    for (const c of present) {
      const knows = restricted.filter((f) => engine.knows(c.id, f)).map((f) => f.id);
      const unknown = restricted.filter((f) => !engine.knows(c.id, f)).map((f) => f.id);
      out.push(`- ${c.name}${c.isPlayer ? ' (você)' : ''}: sabe ${knows.join(', ') || 'nenhum'}; NÃO sabe ${unknown.join(', ') || 'nenhum'}`);
    }
  }

  // "Livre" é o que o jogador fez no grid depois da narração, sem o mestre: andou, ouviu uma fala pronta.
  const recent = s.log.filter((e) => (e.kind === 'player' || e.kind === 'narration' || e.kind === 'free') && e.turn > s.turn - recentTurns);
  const who = { player: 'Jogador', narration: 'Mestre', free: 'Livre' } as Record<string, string>;
  out.push(
    `\n## Últimos acontecimentos\n` +
      (recent.map((e) => `T${e.turn} ${who[e.kind]}: ${e.kind === 'narration' ? truncate(e.text, 1200) : e.text}`).join('\n') || '(início da campanha)') +
      (recent.some((e) => e.kind === 'free') ? '\n(Livre: o que o jogador fez no grid depois da narração, sem você. Continue de onde ele está.)' : '') +
      (s.turnClock.spent > 0
        ? `\n(Tempo do turno: o jogador usou ${formatDuration(s.turnClock.spent)} de ${formatDuration(s.turnClock.budget)} no grid; o relógio do mundo já andou com isso, não o adiante de novo.)`
        : ''),
  );
  return out.join('\n');
}

/** As falas prontas do NPC, para o mestre manter a voz dele e saber quem ainda não tem as gerais. */
function linesNote(c: Character): string {
  const quote = (list: ReadyLine[]) =>
    list
      .map((l) => {
        const replies = l.replies?.length ? ` [respostas: ${l.replies.map((r) => `${r.label} → «${truncate(r.answer, 80)}»`).join('; ')}]` : '';
        return `«${truncate(l.text, 120)}»${l.fact ? ` (conta ${l.fact})` : ''}${l.introduces ? ' (diz o nome)' : ''}${l.whisper ? ' (cochicho)' : ''}${replies}`;
      })
      .join(' ');
  const turn = c.lines?.turn.length ? `; falas do turno: ${quote(c.lines.turn)}` : '';
  const initiative = c.lines?.initiative ? `; iniciativa: ${c.lines.initiative}` : '';
  return `${turn}${initiative}${c.lines?.general.length ? `; falas gerais: ${quote(c.lines.general)}` : '; sem falas gerais'}`;
}
