import { DIFFICULTY_LABEL, VISIBILITY_LABEL, type GameEngine } from './engine';
import { LEGEND } from './layout';
import { perceptionOf } from './perception';
import { formatClock, truncate } from './text';
import type { Character, DifficultyName, Location, PerkDef, Visibility } from './types';

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

function shortId(loc: Location, id: string): string {
  return id.startsWith(`${loc.id}/`) ? id.slice(loc.id.length + 1) : id;
}

export function describePerk(perk: PerkDef): string {
  const effects = perk.grants.map((g) => {
    if (g.kind === 'see_stat') return `vê ${g.stat} de todos`;
    if (g.kind === 'see_thoughts') return 'percebe o que os outros pensam';
    if (g.kind === 'sense') {
      const mult = g.multiplier !== undefined ? ` ×${g.multiplier}` : '';
      const bonus = g.bonus ? ` ${g.bonus > 0 ? '+' : ''}${g.bonus} tiles` : '';
      return `sentido ${g.channel}${mult}${bonus}`;
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
  if (rules.perks.length) out.push(`Perks: ${rules.perks.map((perk) => `${perk.id} (${perk.name}: ${describePerk(perk)})`).join('; ')}.`);

  const loc = engine.currentLocation;
  const sceneIds = new Set<string>();
  if (!loc) {
    out.push('\n(Nenhum local criado ainda.)');
  } else {
    sceneIds.add(loc.id);
    const { map, markers } = renderMap(engine, loc);
    out.push(`\n## Local atual: ${loc.name} [${loc.id}], ${loc.width}×${loc.height}, ${loc.outdoor ? 'área aberta' : 'interior'}`);
    if (loc.description) out.push(loc.description);
    out.push('```', map, '```');
    const used = [...new Set(loc.tiles.join(''))].map((ch) => LEGEND[ch]).filter((d) => d && d.char !== ' ');
    out.push(
      `Legenda: ${used.map((d) => `'${d.char}' ${d.label}`).join(', ')}; '@' você; outros marcadores = personagens listados abaixo. ` +
        `x = coluna, y = linha. Ids de móveis começam com "${loc.id}/".`,
    );

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
    const people = engine.charactersIn(loc.id).map((c) => {
      sceneIds.add(c.id);
      const mind = c.thoughts ? `; pensa${view.canSeeThoughts(c.id) ? ' (o jogador percebe)' : ''}: "${truncate(c.thoughts, 160)}"` : '';
      const where = c.seatId ? `sentado(a) em ${shortId(loc, c.seatId)}` : 'em pé';
      const res = resourceLine(engine, c, !c.isPlayer);
      const perks = engine.perksOf(c).map((perk) => perk.name);
      return (
        `- ${markers.get(c.id) ?? '?'} ${c.name} [${c.id}]${c.isPlayer ? ' (VOCÊ, jogador)' : ''}: ${c.role}; ${where} (${c.pos?.x},${c.pos?.y}), olhando ${c.facing}; ` +
        `${c.detail === 'sketch' ? 'esboço' : 'completo'}; traços: ${c.traits.join(', ') || '—'}${res ? `; ${res}` : ''}` +
        `${perks.length ? `; perks: ${perks.join(', ')}` : ''}${mind}`
      );
    });
    out.push(`\nPersonagens aqui:\n${people.join('\n') || '(ninguém)'}`);

    const ground = engine.itemsOnGround(loc.id);
    if (ground.length) {
      out.push(`Itens no chão: ${ground.map((i) => `${i.name} [${i.id}] (${i.holder.kind === 'ground' ? `${i.holder.x},${i.holder.y}` : ''})`).join(', ')}`);
      for (const i of ground) sceneIds.add(i.id);
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
    out.push(`Inventário: ${inv.map((i) => `${i.name} [${i.id}]${i.quantity > 1 ? ` ×${i.quantity}` : ''}`).join(', ') || 'vazio'}`);
    const perks = engine.perksOf(p);
    out.push(
      `Perks: ${perks.map((perk) => `${perk.name} (${describePerk(perk)})`).join('; ') || 'nenhum'}. ` +
        'O jogador só percebe os valores ocultos que os perks mostram e os pensamentos marcados com "(o jogador percebe)"; não revele os outros na narração.',
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

  const recent = s.log.filter((e) => (e.kind === 'player' || e.kind === 'narration') && e.turn > s.turn - recentTurns);
  out.push(
    `\n## Últimos acontecimentos\n` +
      (recent.map((e) => `T${e.turn} ${e.kind === 'player' ? 'Jogador' : 'Mestre'}: ${e.kind === 'player' ? e.text : truncate(e.text, 1200)}`).join('\n') ||
        '(início da campanha)'),
  );
  return out.join('\n');
}
