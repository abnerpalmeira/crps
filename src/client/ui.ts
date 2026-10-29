import { perceptionOf } from '../engine/perception';
import { formatClock } from '../engine/text';
import type { Character, LogEntry, WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';
import type { CostEvent } from '../gm/pricing';
import type { Usage } from '../gm/provider';
import { escapeHtml, formatNarration, inline, type Speaker } from './format';
import type { PlaybackState } from './playback';
import { hash } from './props';
import type { Pick } from './scene';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Atributos e recursos de um personagem como texto, com o id da regra para checar visibilidade. */
function statTexts(world: WorldState, c: Character): { id: string; text: string }[] {
  return [
    ...world.ruleset.attributes.map((a) => ({ id: a.id, text: `${a.name} ${c.attributes[a.id] ?? 0}` })),
    ...world.ruleset.resources.map((r) => ({ id: r.id, text: `${r.name} ${c.resources[r.id] ?? r.max}/${r.max}` })),
  ];
}

const usd = (value: number) => `US$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`;
const credits = (n: number) => `${n} ${n === 1 ? 'crédito' : 'créditos'}`;

type ChipKind = 'dice' | 'world' | 'backstage';

function chipKind(summary: string, ok: boolean): ChipKind {
  // 🤫 = fato que o personagem do jogador não conhece: só aparece nos bastidores.
  if (!ok || /^(🔎|🧠|⚠️|🤫)/u.test(summary)) return 'backstage';
  return summary.startsWith('🎲') ? 'dice' : 'world';
}

const SUGGESTIONS = [
  'Um slice of life em que eu sou professor de uma escola japonesa e começo o meu dia na sala de aula com um giz.',
  'Sou detetive particular numa Lisboa chuvosa de 1952 e acabo de abrir o escritório quando alguém bate à porta.',
  'Sou a dona de uma taverna numa vila de fronteira, na noite em que uma caravana chega machucada.',
];

interface TurnContext {
  speaker: (id: string) => Speaker | null;
  onReplay: (turn: number) => void;
}

/** Um turno no registro: fala do jogador, chips do motor e a narração (que pode ser reescrita). */
export class TurnView {
  private readonly root = el('li', 'turn');
  private readonly chips = el('div', 'chips');
  private readonly narration = el('div', 'narration live');
  private readonly status = el('div', 'status');
  private raw = '';

  constructor(
    private readonly log: HTMLElement,
    input: string | null,
    private readonly ctx: TurnContext,
  ) {
    if (input) this.root.append(el('div', 'player-line', input));
    this.root.append(this.chips, this.status, this.narration);
    log.append(this.root);
    this.scroll();
  }

  tool(e: Extract<GmEvent, { type: 'tool' }>): void {
    const kind = chipKind(e.summary, e.ok);
    const chip = el('span', `chip ${kind}`, e.summary);
    // Entrada e resultado podem ter valores ocultos: o detalhe fica só nos chips de bastidores.
    if (kind === 'backstage') chip.title = `${e.name}\n\nentrada: ${JSON.stringify(e.input, null, 1)}\n\nresultado: ${e.result.slice(0, 800)}`;
    this.chips.append(chip);
    this.scroll();
  }

  delta(text: string): void {
    this.raw += text;
    this.status.textContent = '';
    this.narration.innerHTML = formatNarration(this.raw, this.ctx.speaker);
    this.scroll();
  }

  reset(): void {
    this.raw = '';
    this.narration.innerHTML = '';
  }

  final(text: string): void {
    this.raw = text;
    this.status.textContent = '';
    this.narration.innerHTML = formatNarration(text, this.ctx.speaker);
    this.narration.classList.remove('live');
    this.scroll();
  }

  /** Custo do turno: US$ no modo dev, só créditos no release. */
  cost(e: CostEvent): void {
    const meta = el('div', 'turn-meta', e.usd === undefined ? `🪙 ${credits(e.credits)}` : `💲 ${usd(e.usd)} · ${credits(e.credits)}`);
    if (e.detail) meta.title = e.detail;
    this.root.insertBefore(meta, this.root.querySelector('.replay'));
  }

  /** Liga o turno ao replay: botão para rever no 3D. */
  setTurn(turn: number): void {
    if (this.root.querySelector('.replay')) return;
    const button = el('button', 'replay', '▶ rever');
    button.type = 'button';
    button.title = 'Rever este turno no 3D, com os balões de fala';
    button.addEventListener('click', () => this.ctx.onReplay(turn));
    this.root.append(button);
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  note(text: string): void {
    this.chips.append(el('span', 'chip note', text));
  }

  error(message: string): void {
    this.root.append(el('div', 'error', message));
    this.scroll();
  }

  finish(): void {
    this.status.textContent = '';
    this.narration.classList.remove('live');
  }

  private scroll(): void {
    const scroller = this.log.closest('.scroll');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }
}

export class Ui {
  onSend: (text: string) => void = () => {};
  onNewGame: (premise: string) => void = () => {};
  onSelect: (pick: Pick | null) => void = () => {};
  onReplay: (turn: number) => void = () => {};
  onControl: (command: string) => void = () => {};

  private readonly log = $('#log');
  private readonly input = $<HTMLTextAreaElement>('#input');
  private readonly send = $<HTMLButtonElement>('#send');
  private readonly dialog = $<HTMLDialogElement>('#new-game');
  private readonly premise = $<HTMLTextAreaElement>('#premise');
  private readonly inspector = $('#inspector');
  private usage = { input: 0, cached: 0, output: 0 };
  private spent = { usd: 0, credits: 0 };
  private mode: 'dev' | 'release' = 'dev';
  private busy = false;
  private inspected: Pick | null = null;
  private world: WorldState | null = null;
  private readonly ctx: TurnContext = {
    speaker: (id) => this.speaker(id),
    onReplay: (turn) => this.onReplay(turn),
  };

  constructor() {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
      tab.addEventListener('click', () => this.showTab(tab.dataset.tab!));
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-cmd]')) {
      button.addEventListener('click', () => this.onControl(button.dataset.cmd!));
    }
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    $('#new-game-button').addEventListener('click', () => this.openNewGame(false));
    $('#backstage').addEventListener('change', (e) => document.body.classList.toggle('backstage', (e.target as HTMLInputElement).checked));
    const suggestions = $('#suggestions');
    for (const text of SUGGESTIONS) {
      const b = el('button', 'suggestion', text);
      b.type = 'button';
      b.addEventListener('click', () => (this.premise.value = text));
      suggestions.append(b);
    }
    $('#start').addEventListener('click', (e) => {
      e.preventDefault();
      const premise = this.premise.value.trim();
      if (!premise) return this.premise.focus();
      this.dialog.close();
      this.onNewGame(premise);
    });
    $('#cancel').addEventListener('click', () => this.dialog.close());
  }

  openNewGame(firstTime: boolean): void {
    $('#cancel').hidden = firstTime;
    if (!this.premise.value) this.premise.value = SUGGESTIONS[0];
    this.dialog.showModal();
  }

  setModel(label: string): void {
    $('#model').textContent = label;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.send.disabled = busy;
    document.body.classList.toggle('busy', busy);
    if (!busy) this.input.focus();
  }

  prefill(text: string): void {
    this.input.value = text;
    this.input.focus();
    this.input.setSelectionRange(text.length, text.length);
    this.showTab('log');
  }

  beginTurn(input: string | null): TurnView {
    $('#empty-log').hidden = true;
    return new TurnView(this.log, input, this.ctx);
  }

  clearLog(): void {
    this.log.replaceChildren();
    this.closeInspector();
  }

  notice(text: string): void {
    this.log.append(el('li', 'notice', text));
  }

  /** dev: custo em US$, tokens e bastidores; release: só créditos, sem bastidores. */
  setMode(mode: 'dev' | 'release'): void {
    this.mode = mode;
    document.body.classList.toggle('release', mode === 'release');
    if (mode === 'release') {
      document.body.classList.remove('backstage');
      $<HTMLInputElement>('#backstage').checked = false;
    }
  }

  addUsage(u: Usage): void {
    this.usage.input += u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    this.usage.cached += u.cacheReadTokens;
    this.usage.output += u.outputTokens;
    this.renderFooter();
  }

  addCost(e: CostEvent): void {
    this.spent.credits += e.credits;
    this.spent.usd += e.usd ?? 0;
    this.renderFooter();
  }

  private renderFooter(): void {
    const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const session = `nesta sessão: ${this.mode === 'dev' ? `${usd(this.spent.usd)} (${credits(this.spent.credits)})` : credits(this.spent.credits)}`;
    const tokens =
      this.mode === 'dev' && this.usage.input
        ? ` · ${k(this.usage.input)} tokens de entrada (${k(this.usage.cached)} do cache), ${k(this.usage.output)} de saída`
        : '';
    $('#usage').textContent = session + tokens;
  }

  /** Legenda do replay: narração, ação do jogador ou fala de quem não está em cena. */
  caption(text: string | null, who?: string): void {
    const caption = $('#caption');
    caption.hidden = !text;
    if (text) caption.innerHTML = `${who ? `<b>${escapeHtml(who)}</b> ` : ''}${inline(text)}`;
  }

  controls(s: PlaybackState): void {
    $('#player-bar').hidden = !s.hasFrames;
    $('#play-toggle').textContent = s.playing ? '❚❚' : '▶';
    $('#play-toggle').title = s.playing ? 'Pausar (espaço)' : 'Tocar (espaço)';
    $<HTMLButtonElement>('[data-cmd="prevFrame"]').disabled = !s.canPrevFrame;
    $<HTMLButtonElement>('[data-cmd="nextFrame"]').disabled = !s.canNextFrame;
    $('#player-label').textContent = s.turn === null ? 'ao vivo' : `turno ${s.turn} · ${s.beat}/${s.beats}`;
    $('[data-cmd="live"]').hidden = s.turn === null;
    document.body.classList.toggle('replaying', s.replaying);
    const shown = s.replaying && s.clock ? { clock: s.clock, turn: s.turn } : this.world;
    if (shown) $('#hud-clock').textContent = `${formatClock(shown.clock)} · turno ${shown.turn}`;
  }

  /** Reconstrói o registro a partir do log salvo no mundo. */
  renderHistory(world: WorldState): void {
    this.world = world;
    this.log.replaceChildren();
    const byTurn = new Map<number, LogEntry[]>();
    for (const entry of world.log) byTurn.set(entry.turn, [...(byTurn.get(entry.turn) ?? []), entry]);
    for (const [turnNumber, entries] of byTurn) {
      const turn = new TurnView(this.log, entries.find((e) => e.kind === 'player')?.text ?? null, this.ctx);
      for (const e of entries) {
        if (e.kind === 'tool') turn.tool({ type: 'tool', name: '', ok: true, summary: e.text, input: null, result: '' });
        if (e.kind === 'narration') {
          turn.final(e.text);
          turn.setTurn(turnNumber);
        }
        if (e.kind === 'system') turn.note(e.text);
      }
      turn.finish();
    }
    $('#empty-log').hidden = world.log.length > 0;
  }

  renderWorld(world: WorldState): void {
    this.world = world;
    const player = world.playerId ? world.characters[world.playerId] : null;
    const loc = player?.locationId ? world.locations[player.locationId] : Object.values(world.locations).at(-1);
    $('#hud-location').textContent = loc?.name ?? 'Montando o mundo…';
    $('#hud-clock').textContent = `${formatClock(world.clock)} · turno ${world.turn}`;
    $('#stage-empty').hidden = Boolean(loc);
    this.renderSheet(world, player);
    this.renderJournal(world, player);
    if (this.inspected) this.showInspector(world, this.inspected);
  }

  renderNoWorld(): void {
    this.world = null;
    $('#hud-location').textContent = 'CRPS';
    $('#hud-clock').textContent = '';
    $('#stage-empty').hidden = false;
    $('#tab-sheet').replaceChildren(el('p', 'muted', 'Seu personagem aparece aqui assim que o mundo estiver pronto.'));
    $('#tab-journal').replaceChildren();
    this.closeInspector();
  }

  showInspector(world: WorldState | null, pick: Pick | null): void {
    this.inspected = pick;
    if (!world || !pick) return this.closeInspector();
    const body = el('div', 'inspector-body');
    const actions: [string, string][] = [];
    if (pick.kind === 'character') {
      const c = world.characters[pick.id];
      if (!c) return this.closeInspector();
      body.append(el('h3', '', c.name), el('p', 'muted', c.role), el('p', '', c.appearance));
      if (c.traits.length) body.append(this.traits(c.traits));
      if (c.detail === 'full') {
        if (c.personality) body.append(el('p', '', c.personality));
        if (c.background) body.append(el('p', 'muted', c.background));
      } else body.append(el('p', 'hint', 'Ainda um esboço: o mestre aprofunda quando a pessoa ficar importante.'));
      const held = Object.values(world.items).filter((i) => i.holder.kind === 'character' && i.holder.id === c.id);
      if (held.length) body.append(el('p', 'muted', `Com: ${held.map((i) => i.name).join(', ')}`));
      if (!c.isPlayer) {
        const view = perceptionOf(world, world.playerId);
        const stats = statTexts(world, c);
        const visible = stats.filter((s) => view.canSeeStat(s.id, c.id)).map((s) => s.text);
        if (visible.length) body.append(el('p', 'muted', visible.join(' · ')));
        if (c.thoughts && view.canSeeThoughts(c.id)) body.append(el('p', 'thought', `💭 ${c.thoughts}`));
        // Bastidores: tudo o que o mestre sabe sobre o NPC.
        const box = el('div', 'backstage-only');
        const perks = c.perks.flatMap((id) => world.ruleset.perks.filter((p) => p.id === id).map((p) => p.name));
        const secrets = world.facts.filter((f) => f.knownBy !== 'all' && f.knownBy.includes(c.id));
        box.append(el('p', 'hint', `Ficha (bastidores): ${stats.map((s) => s.text).join(' · ')}`));
        if (perks.length) box.append(el('p', 'hint', `Perks (bastidores): ${perks.join(', ')}`));
        if (c.thoughts) box.append(el('p', 'hint', `Pensa (bastidores): ${c.thoughts}`));
        if (secrets.length) box.append(el('p', 'hint', `Sabe (bastidores): ${secrets.map((f) => f.text).join(' · ')}`));
        body.append(box);
      }
      if (!c.isPlayer) {
        const first = c.name.split(' ')[0];
        actions.push([`Falar com ${first}`, `Digo a ${first}: "`], [`Ir até ${first}`, `Vou até ${first}.`]);
      }
    } else if (pick.kind === 'fixture') {
      const f = Object.values(world.locations).flatMap((l) => l.fixtures).find((fx) => fx.id === pick.id);
      if (!f) return this.closeInspector();
      body.append(el('h3', '', f.label[0].toUpperCase() + f.label.slice(1)));
      if (f.text) body.append(el('p', 'board-text', f.text));
      if (f.state) body.append(el('p', 'muted', f.state));
      const on = Object.values(world.items).filter((i) => i.holder.kind === 'fixture' && i.holder.id === f.id);
      if (on.length) body.append(el('p', 'muted', `Aqui: ${on.map((i) => i.name).join(', ')}`));
      const sitter = Object.values(world.characters).find((c) => c.seatId === f.id);
      if (sitter) body.append(el('p', 'muted', `Ocupado por ${sitter.name}`));
      actions.push([`Ir até ${f.label}`, `Vou até ${f.kind === 'board' ? 'o quadro' : `a ${f.label}`}.`]);
      if (f.kind === 'board') actions.push(['Escrever no quadro', 'Escrevo no quadro: "']);
    } else {
      const item = world.items[pick.id];
      if (!item) return this.closeInspector();
      body.append(el('h3', '', item.name), el('p', '', item.description));
      actions.push([`Pegar ${item.name}`, `Pego ${item.name.toLowerCase()}.`]);
    }
    if (actions.length) {
      const row = el('div', 'actions');
      for (const [label, text] of actions) {
        const b = el('button', 'action', label);
        b.addEventListener('click', () => this.prefill(text));
        row.append(b);
      }
      body.append(row);
    }
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Fechar');
    close.addEventListener('click', () => this.onSelect(null));
    this.inspector.replaceChildren(close, body);
    this.inspector.hidden = false;
  }

  private speaker(id: string): Speaker | null {
    const c = this.world?.characters[id];
    if (!c) return null;
    return { name: c.name, color: c.isPlayer ? 'var(--accent)' : `hsl(${hash(c.id) % 360} 62% 72%)` };
  }

  private closeInspector(): void {
    this.inspected = null;
    this.inspector.hidden = true;
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text || this.busy) return;
    this.input.value = '';
    this.onSend(text);
  }

  private showTab(name: string): void {
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const panel of document.querySelectorAll<HTMLElement>('.tab')) panel.hidden = panel.id !== `tab-${name}`;
  }

  private traits(list: string[]): HTMLElement {
    const row = el('div', 'traits');
    for (const t of list) row.append(el('span', 'trait', t));
    return row;
  }

  private renderSheet(world: WorldState, player: Character | null): void {
    const sheet = $('#tab-sheet');
    if (!player) {
      sheet.replaceChildren(el('p', 'muted', 'Seu personagem aparece aqui assim que o mundo estiver pronto.'));
      return;
    }
    const rules = world.ruleset;
    const view = perceptionOf(world, player.id);
    const parts: HTMLElement[] = [el('h2', '', player.name), el('p', 'muted', player.role), el('p', '', player.appearance)];
    if (player.traits.length) parts.push(this.traits(player.traits));

    parts.push(el('h3', '', `Atributos · ${rules.name}`));
    for (const a of rules.attributes.filter((def) => view.canSeeStat(def.id, player.id))) {
      const row = el('div', 'stat');
      row.title = a.description;
      const pips = el('span', 'pips');
      for (let i = 1; i <= 5; i++) pips.append(el('i', i <= (player.attributes[a.id] ?? 0) ? 'on' : ''));
      row.append(el('span', '', a.name), pips);
      parts.push(row);
    }
    const resources = rules.resources.filter((def) => view.canSeeStat(def.id, player.id));
    if (resources.length) {
      parts.push(el('h3', '', 'Recursos'));
      for (const r of resources) {
        const value = player.resources[r.id] ?? r.max;
        const row = el('div', 'resource');
        const bar = el('span', 'bar');
        const fill = el('i');
        fill.style.width = `${(100 * value) / r.max}%`;
        bar.append(fill);
        row.append(el('span', '', r.name), bar, el('span', 'num', `${value}/${r.max}`));
        parts.push(row);
      }
    }
    const skills = Object.entries(player.skills);
    if (skills.length) {
      parts.push(el('h3', '', 'Perícias'));
      parts.push(el('p', '', skills.map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')));
    }
    if (view.perks.length) {
      parts.push(el('h3', '', 'Perks'));
      for (const p of view.perks) {
        const row = el('div', 'item');
        row.append(el('strong', '', p.name), el('span', 'muted', p.description));
        parts.push(row);
      }
    }
    const hidden = statTexts(world, player).filter((s) => !view.canSeeStat(s.id, player.id));
    if (hidden.length) {
      const box = el('div', 'backstage-only');
      box.append(el('p', 'hint', `Ocultos para você (bastidores): ${hidden.map((s) => s.text).join(' · ')}`));
      parts.push(box);
    }
    parts.push(el('h3', '', 'Inventário'));
    const items = Object.values(world.items).filter((i) => i.holder.kind === 'character' && i.holder.id === player.id);
    if (!items.length) parts.push(el('p', 'muted', 'Vazio.'));
    for (const i of items) {
      const row = el('div', 'item');
      row.append(el('strong', '', `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`), el('span', 'muted', i.description));
      parts.push(row);
    }
    sheet.replaceChildren(...parts);
  }

  private renderJournal(world: WorldState, player: Character | null): void {
    const journal = $('#tab-journal');
    const parts: HTMLElement[] = [el('h3', '', 'Objetivos')];
    const threads = Object.values(world.threads);
    if (!threads.length) parts.push(el('p', 'muted', 'Nenhum por enquanto.'));
    for (const t of threads) {
      const row = el('div', `thread ${t.status}`);
      row.append(el('strong', '', t.title), el('span', 'muted', t.description));
      parts.push(row);
    }
    parts.push(el('h3', '', 'O que você sabe'));
    const known = world.facts.filter((f) => f.knownBy === 'all' || (player && f.knownBy.includes(player.id))).reverse();
    if (!known.length) parts.push(el('p', 'muted', 'Nada registrado ainda.'));
    for (const f of known.slice(0, 60)) parts.push(el('p', 'fact', f.text));
    if (player?.locationId) {
      parts.push(el('h3', '', 'Pessoas aqui'));
      for (const c of Object.values(world.characters)) {
        if (c.locationId !== player.locationId || c.isPlayer) continue;
        const b = el('button', 'person');
        b.append(el('strong', '', c.name), el('span', 'muted', ` ${c.role}`));
        b.addEventListener('click', () => this.onSelect({ kind: 'character', id: c.id }));
        parts.push(b);
      }
    }
    journal.replaceChildren(...parts);
  }
}
