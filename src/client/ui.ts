import { actLabel, actionsFor, type ActionOption } from '../engine/actions';
import { lightAt, lightLabel, lightSources } from '../engine/light';
import { FEELING_LABELS, feelingsHere, perceptionOf, strangerLabel } from '../engine/perception';
import { findByName, hasMarks, parsePlayerInput, type InputSegment } from '../engine/input';
import { chebyshev, formatClock, hhmm, signed } from '../engine/text';
import type { Character, LogEntry, WorldState } from '../engine/types';
import type { GmEvent } from '../gm/gm';
import type { CostEvent } from '../gm/pricing';
import type { Usage } from '../gm/provider';
import type { ModelOption } from './api';
import { INPUT_ICON, capitalize, escapeHtml, formatNarration, formatPlayerInput, inline, type Speaker } from './format';
import { randomPremise } from './premises';
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
  world: () => WorldState | null;
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
    if (input) {
      const line = el('div', 'player-line');
      line.innerHTML = formatPlayerInput(input, ctx.world());
      this.root.append(line);
    }
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
  onModel: (id: string) => void = () => {};

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
  private model = { current: '', options: [] as ModelOption[] };
  private inspected: Pick | null = null;
  private world: WorldState | null = null;
  private readonly ctx: TurnContext = {
    speaker: (id) => this.speaker(id),
    world: () => this.world,
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
    const roll = $('#roll-premise');
    roll.addEventListener('click', () => {
      this.premise.value = randomPremise(Math.random, this.premise.value);
      // Reinicia a animação do dado a cada clique.
      roll.classList.remove('rolling');
      void roll.offsetWidth;
      roll.classList.add('rolling');
    });
    $('#model').addEventListener('click', () => this.toggleModelMenu());
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tag]')) {
      button.addEventListener('click', () => this.tag(button.dataset.tag as InputSegment['kind']));
    }
    this.input.addEventListener('input', () => this.renderPreview());
    document.addEventListener('click', (e) => {
      if (!$('.brand').contains(e.target as Node)) this.closeModelMenu();
      if (!(e.target as Element).closest?.('#whisper-menu, [data-tag="sussurro"]')) $('#whisper-menu').hidden = true;
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      this.closeModelMenu();
      $('#whisper-menu').hidden = true;
    });
  }

  openNewGame(firstTime: boolean): void {
    $('#cancel').hidden = firstTime;
    if (!this.premise.value) this.premise.value = SUGGESTIONS[0];
    this.dialog.showModal();
  }

  /** Nome do modelo no topo; com opções (modo dev, fora da demo), clicar abre o seletor. */
  setModel(current: string, options: ModelOption[] = this.model.options): void {
    this.model = { current, options };
    const button = $<HTMLButtonElement>('#model');
    const choice = options.find((m) => m.id === current);
    button.textContent = choice ? `${choice.name} ▾` : current;
    button.hidden = !current;
    button.disabled = !options.length || this.busy;
    button.title = options.length ? 'Trocar o modelo do mestre' : current;
  }

  private toggleModelMenu(): void {
    const menu = $('#model-menu');
    if (!menu.hidden) return this.closeModelMenu();
    const money = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
    menu.replaceChildren(
      ...this.model.options.map((m) => {
        const b = el('button', `model-option${m.id === this.model.current ? ' current' : ''}`);
        b.type = 'button';
        b.setAttribute('role', 'menuitemradio');
        b.setAttribute('aria-checked', String(m.id === this.model.current));
        b.append(el('strong', '', m.name), el('span', 'price', m.price ? `US$ ${money(m.price.input)} / ${money(m.price.output)}` : ''), el('span', 'muted', m.note));
        b.addEventListener('click', () => {
          this.closeModelMenu();
          if (m.id !== this.model.current) this.onModel(m.id);
        });
        return b;
      }),
      el('p', 'hint', 'Preço por milhão de tokens (entrada / saída). Vale a partir do próximo turno.'),
    );
    menu.hidden = false;
    $('#model').setAttribute('aria-expanded', 'true');
  }

  private closeModelMenu(): void {
    $('#model-menu').hidden = true;
    $('#model').setAttribute('aria-expanded', 'false');
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.send.disabled = busy;
    $<HTMLButtonElement>('#model').disabled = busy || !this.model.options.length;
    if (busy) this.closeModelMenu();
    document.body.classList.toggle('busy', busy);
    if (!busy) this.input.focus();
  }

  /** Completa a ação com um texto (fala, escrita) depois do que já está escrito, com o cursor no fim. */
  prefill(text: string): void {
    const before = this.input.value.trimEnd();
    this.input.value = before ? `${before} ${text}` : text;
    const end = this.input.value.length;
    this.input.focus();
    this.input.setSelectionRange(end, end);
    this.showTab('log');
    this.renderPreview();
  }

  /** Põe a marca de uma ação do menu onde está o cursor, com espaço dos dois lados. */
  private insertToken(token: string): void {
    const input = this.input;
    const { selectionStart: a, selectionEnd: b, value } = input;
    const before = value.slice(0, a);
    const after = value.slice(b);
    const pre = before && !/\s$/.test(before) ? ' ' : '';
    const post = after && !/^\s/.test(after) ? ' ' : '';
    input.value = `${before}${pre}${token}${post}${after}`;
    const caret = before.length + pre.length + token.length + post.length;
    input.focus();
    input.setSelectionRange(caret, caret);
    this.showTab('log');
    this.renderPreview();
  }

  /** Botões de marca: envolvem o trecho selecionado (ou o cursor) e deixam o cursor dentro. */
  private tag(kind: InputSegment['kind']): void {
    if (kind === 'sussurro') return this.toggleWhisperMenu();
    const [open, close] = kind === 'fala' ? ['"', '"'] : kind === 'pensamento' ? ['(', ')'] : ['*', '*'];
    this.wrap(open, close);
  }

  private wrap(open: string, close: string): void {
    const input = this.input;
    const { selectionStart: a, selectionEnd: b, value } = input;
    const selected = value.slice(a, b);
    const before = value.slice(0, a);
    const spacer = before && !/\s$/.test(before) ? ' ' : '';
    input.value = `${before}${spacer}${open}${selected}${close}${value.slice(b)}`;
    const caret = a + spacer.length + open.length + selected.length + (selected ? close.length : 0);
    input.focus();
    input.setSelectionRange(caret, caret);
    this.renderPreview();
  }

  /** Quem está no mesmo local, do mais perto ao mais longe, para escolher a quem sussurrar. */
  private toggleWhisperMenu(): void {
    const menu = $('#whisper-menu');
    if (!menu.hidden) return void (menu.hidden = true);
    const world = this.world;
    const player = world?.playerId ? world.characters[world.playerId] : null;
    if (!world || !player?.pos) return;
    const reach = world.ruleset.speech.cochicho?.reach ?? 2;
    const view = perceptionOf(world, world.playerId);
    // Quem ele sabe quem é, pelo nome; estranhos que ele vê, pela descrição; vultos que não reconhece ficam de fora.
    const people = Object.values(world.characters)
      .filter((c) => !c.isPlayer && c.pos && c.locationId === player.locationId && (view.recognize(c.id) || view.sight(c.id) === 'nitido'))
      .map((c) => ({ c, d: chebyshev(player.pos!, c.pos!) }))
      .sort((x, y) => x.d - y.d);
    const first = (c: Character) => c.name.split(' ')[0];
    const items = people.map(({ c, d }) => {
      const b = el('button', 'whisper-option');
      b.type = 'button';
      const known = view.recognize(c.id);
      // Primeiro nome, ou o id se outro presente tiver o mesmo primeiro nome; estranho, @[descrição].
      const ref = !known ? `[${strangerLabel(c)}]` : people.filter((p) => first(p.c) === first(c)).length > 1 ? c.id : first(c);
      b.append(
        el('strong', '', known ? c.name : capitalize(strangerLabel(c))),
        el('span', 'muted', d <= reach ? 'ao seu lado' : `a ${d} passos; o mestre leva você até lá`),
      );
      b.addEventListener('click', () => {
        menu.hidden = true;
        this.wrap(`@${ref} "`, '"');
      });
      return b;
    });
    menu.replaceChildren(el('p', 'hint', 'Sussurrar para…'), ...(items.length ? items : [el('p', 'muted', 'Não há ninguém aqui.')]));
    menu.hidden = false;
  }

  /** Prévia de como o mestre vai entender a ação: uma etiqueta por parte marcada. */
  private renderPreview(): void {
    const preview = $('#input-preview');
    const segments = parsePlayerInput(this.input.value);
    if (!hasMarks(segments)) return void preview.replaceChildren();
    const world = this.world;
    const player = world?.playerId ? world.characters[world.playerId] : null;
    preview.replaceChildren(
      ...segments.map((s) => {
        const chip = el('span', `in-chip ${s.kind}`);
        let text = s.text;
        if (s.kind === 'sussurro') {
          const target = world ? findByName(world, s.target ?? '') : null;
          const reach = world?.ruleset.speech.cochicho?.reach ?? 2;
          const d = target?.pos && player?.pos && target.locationId === player.locationId ? chebyshev(target.pos, player.pos) : null;
          // Primeiro nome de quem ele sabe quem é; de um estranho, a descrição inteira.
          const known = target && world ? perceptionOf(world, world.playerId).recognize(target.id) : null;
          const who = target && world ? (known ? target.name.split(' ')[0] : shownAs(world, target)) : null;
          text = `${who ?? `${s.target}?`}: ${s.text}`;
          if (!target) chip.classList.add('warn');
          chip.title = !target ? 'Ninguém com esse nome aqui.' : d !== null && d > reach ? `${capitalize(who!)} está a ${d} passos: o mestre leva você até lá.` : '';
        }
        if (s.kind === 'pensamento') chip.title = 'Só você ouve, a não ser quem lê mentes.';
        if (s.kind === 'menu') {
          // Ação do menu: o motor faz na hora o que é físico (sentar, pegar…); o resto vai ao mestre.
          const label = actLabel(world, s.act!);
          chip.textContent = label.length > 60 ? `${label.slice(0, 59)}…` : label;
          return chip;
        }
        chip.textContent = `${INPUT_ICON[s.kind]} ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`;
        return chip;
      }),
    );
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
    $('#hud-sense').textContent = senseText(world);
    $('#stage-empty').hidden = Boolean(loc);
    this.renderSheet(world, player);
    this.renderJournal(world, player);
    if (this.inspected) this.showInspector(world, this.inspected);
  }

  renderNoWorld(): void {
    this.world = null;
    $('#hud-location').textContent = 'CRPS';
    $('#hud-clock').textContent = '';
    $('#hud-sense').textContent = '';
    $('#stage-empty').hidden = false;
    $('#tab-sheet').replaceChildren(el('p', 'muted', 'Seu personagem aparece aqui assim que o mundo estiver pronto.'));
    $('#tab-journal').replaceChildren();
    this.closeInspector();
  }

  showInspector(world: WorldState | null, pick: Pick | null): void {
    this.inspected = pick;
    if (!world || !pick) return this.closeInspector();
    const body = el('div', 'inspector-body');
    const actions: ActionOption[] = [];
    if (pick.kind === 'character') {
      const c = world.characters[pick.id];
      if (!c) return this.closeInspector();
      const view = perceptionOf(world, world.playerId);
      const sight = c.isPlayer ? 'nitido' : view.sight(c.id);
      // Sabe quem é pelo rosto ou pela voz; sem isso, é um estranho (se o vê) ou um vulto.
      const known = c.isPlayer ? 'rosto' : view.recognize(c.id);
      const truth = () => {
        const box = el('div', 'backstage-only');
        box.append(el('p', 'hint', `Na verdade (bastidores): ${c.name}, ${c.role}`));
        return box;
      };
      if (!known && sight !== 'nitido') {
        body.append(
          el('h3', '', sight === 'vulto' ? 'Um vulto' : 'Alguém?'),
          el('p', 'muted', sight === 'vulto' ? 'Está escuro demais para ver quem é.' : 'Você não enxerga quem está aí.'),
          truth(),
        );
        return this.openInspector(body, [{ label: 'Ir até lá', prefill: 'Vou, com cuidado, na direção do vulto.' }]);
      }
      const stranger = strangerLabel(c);
      if (known) body.append(el('h3', '', c.name), el('p', 'muted', c.role));
      else body.append(el('h3', '', capitalize(stranger)), el('p', 'muted', 'Você não sabe quem é.'), truth());
      body.append(sight === 'nitido' ? el('p', '', c.appearance) : el('p', 'muted', 'Está escuro demais para ver, mas você reconhece a voz.'));
      if (known) {
        if (c.traits.length) body.append(this.traits(c.traits));
        if (c.detail === 'full') {
          if (c.personality) body.append(el('p', '', c.personality));
          if (c.background) body.append(el('p', 'muted', c.background));
        } else body.append(el('p', 'hint', 'Ainda um esboço: o mestre aprofunda quando a pessoa ficar importante.'));
      }
      const held = Object.values(world.items).filter((i) => i.holder.kind === 'character' && i.holder.id === c.id);
      if (held.length && c.isPlayer) {
        // Os próprios itens abrem o inspetor deles.
        const row = el('p', 'muted', 'Com: ');
        for (const i of held) {
          const b = el('button', 'link', i.name);
          b.type = 'button';
          b.addEventListener('click', () => this.showInspector(world, { kind: 'item', id: i.id }));
          row.append(b, ' ');
        }
        body.append(row);
      } else if (held.length && sight === 'nitido') body.append(el('p', 'muted', `Com: ${held.map((i) => i.name).join(', ')}`));
      if (!c.isPlayer) {
        const stats = statTexts(world, c);
        const visible = stats.filter((s) => view.canSeeStat(s.id, c.id)).map((s) => s.text);
        if (visible.length && sight === 'nitido') body.append(el('p', 'muted', visible.join(' · ')));
        if (c.thoughts && view.canSeeThoughts(c.id)) body.append(el('p', 'thought', `💭 ${c.thoughts}`));
        // Quem lê a mente percebe também o que ele sente por quem está ali (o mesmo recorte do resumo do mestre).
        if (view.canSeeThoughts(c.id)) {
          for (const { target, feeling } of feelingsHere(world, c)) {
            const who = target.isPlayer ? 'por você' : withPor(shownAs(world, target));
            body.append(el('p', 'thought', `Sente ${who}: ${FEELING_LABELS[feeling.degree]}${feeling.text ? ` (${feeling.text})` : ''}`));
          }
        }
        // Bastidores: tudo o que o mestre sabe sobre o NPC.
        const box = el('div', 'backstage-only');
        const perks = c.perks.flatMap((id) => world.ruleset.perks.filter((p) => p.id === id).map((p) => p.name));
        const secrets = world.facts.filter((f) => f.knownBy !== 'all' && f.knownBy.includes(c.id));
        box.append(el('p', 'hint', `Ficha (bastidores): ${stats.map((s) => s.text).join(' · ')}`));
        if (perks.length) box.append(el('p', 'hint', `Perks (bastidores): ${perks.join(', ')}`));
        if (c.thoughts) box.append(el('p', 'hint', `Pensa (bastidores): ${c.thoughts}`));
        const feelings = Object.entries(c.feelings).map(([id, f]) => `${world.characters[id]?.name ?? id} ${signed(f.degree)}${f.text ? ` (${f.text})` : ''}`);
        if (feelings.length) box.append(el('p', 'hint', `Sente (bastidores): ${feelings.join(' · ')}`));
        if (secrets.length) box.append(el('p', 'hint', `Sabe (bastidores): ${secrets.map((f) => f.text).join(' · ')}`));
        body.append(box);
      }
      actions.push(...actionsFor(world, pick));
    } else if (pick.kind === 'fixture') {
      const loc = Object.values(world.locations).find((l) => l.fixtures.some((fx) => fx.id === pick.id));
      const f = loc?.fixtures.find((fx) => fx.id === pick.id);
      if (!loc || !f) return this.closeInspector();
      const exit = loc.exits?.[f.id];
      const title = exit?.label ?? f.label;
      body.append(el('h3', '', title[0].toUpperCase() + title.slice(1)));
      if (exit?.to.length) {
        const box = el('div', 'backstage-only');
        box.append(el('p', 'hint', `Leva a (bastidores): ${exit.to.map((id) => world.locations[id]?.name ?? id).join(', ')}`));
        body.append(box);
      }
      if (f.text) body.append(el('p', 'board-text', f.text));
      if (f.state) body.append(el('p', 'muted', f.state));
      const on = Object.values(world.items).filter((i) => i.holder.kind === 'fixture' && i.holder.id === f.id);
      if (on.length) body.append(el('p', 'muted', `Aqui: ${on.map((i) => i.name).join(', ')}`));
      const sitter = Object.values(world.characters).find((c) => c.seatId === f.id);
      if (sitter) body.append(el('p', 'muted', `Ocupado por ${shownAs(world, sitter)}`));
      actions.push(...actionsFor(world, pick));
    } else {
      const item = world.items[pick.id];
      if (!item) return this.closeInspector();
      body.append(el('h3', '', item.name), el('p', '', item.description));
      if (item.light) body.append(el('p', 'muted', item.light.on ? 'Acesa.' : 'Apagada.'));
      // O texto só aparece para quem já leu: é conhecimento, como uma fala ouvida.
      if (item.text !== undefined) {
        const fact = world.facts.find((f) => f.id === item.textFact);
        const read = fact && world.playerId && (fact.knownBy === 'all' || fact.knownBy.includes(world.playerId));
        body.append(read && item.text ? el('p', 'paper', `«${item.text}»`) : el('p', 'muted', 'Tem algo escrito.'));
        const box = el('div', 'backstage-only');
        const readers = fact && fact.knownBy !== 'all' ? fact.knownBy.map((id) => world.characters[id]?.name ?? id).join(', ') : 'todos';
        box.append(el('p', 'hint', item.text ? `Texto (bastidores): «${item.text}» · sabem: ${readers || 'ninguém'}` : 'Texto (bastidores): ainda não lido; a primeira leitura define.'));
        body.append(box);
      }
      actions.push(...actionsFor(world, pick));
    }
    this.openInspector(body, actions);
  }

  /** Botões das ações; uma com mais escolhas (a quem entregar, que gesto) abre a lista no lugar. */
  private renderActions(row: HTMLElement, actions: ActionOption[], back?: () => void): void {
    row.replaceChildren();
    row.classList.toggle('sub', Boolean(back));
    if (back) {
      const b = el('button', 'action back', '‹ voltar');
      b.type = 'button';
      b.addEventListener('click', back);
      row.append(b);
    }
    for (const a of actions) {
      const b = el('button', 'action', a.label);
      b.type = 'button';
      b.disabled = Boolean(a.disabled);
      if (a.note) b.append(el('small', 'note', a.note));
      b.addEventListener('click', () => {
        if (a.options) return this.renderActions(row, a.options, () => this.renderActions(row, actions, back));
        if (a.token) this.insertToken(a.token);
        else if (a.prefill) this.prefill(a.prefill);
      });
      row.append(b);
    }
  }

  private openInspector(body: HTMLElement, actions: ActionOption[]): void {
    if (actions.length) {
      const row = el('div', 'actions');
      this.renderActions(row, actions);
      body.append(row);
    }
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Fechar');
    close.addEventListener('click', () => this.onSelect(null));
    this.inspector.replaceChildren(close, body);
    this.inspector.hidden = false;
  }

  private speaker(id: string): Speaker | null {
    const item = this.world?.items[id];
    if (item) return { name: item.name, color: 'var(--muted)', document: true };
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
    this.renderPreview();
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
    if (player.conditions.length) {
      parts.push(el('h3', '', 'Condições'));
      for (const active of player.conditions) {
        const def = rules.conditions.find((d) => d.id === active.id);
        const row = el('div', 'item condition');
        const until = active.until ? ` · até ${active.until.day === world.clock.day ? hhmm(active.until.minutes) : formatClock(active.until)}` : '';
        row.append(el('strong', '', def?.name ?? active.id), el('span', 'muted', `${def?.description ?? ''}${until}`));
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
      // Clicar no item abre o inspetor dele, com o que dá para fazer (empunhar, ler, entregar…).
      const row = el('button', 'item clickable');
      row.type = 'button';
      const lit = i.light ? (i.light.on ? ' · acesa' : ' · apagada') : '';
      const hand = i.holder.kind === 'character' && i.holder.hand ? ` · na mão ${i.holder.hand}` : '';
      row.append(el('strong', '', `${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`), el('span', 'muted', `${i.description}${lit}${hand}`));
      row.addEventListener('click', () => this.showInspector(world, { kind: 'item', id: i.id }));
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

/** "por" junto do artigo de quem vem depois: pelo homem de terno, pela moça, por Ana. */
function withPor(who: string): string {
  const m = /^(o|a|os|as) (.+)$/i.exec(who);
  return m ? `pel${m[1].toLowerCase()} ${m[2]}` : `por ${who}`;
}

/** Como o jogador chama alguém agora: o nome, se sabe quem é; senão, o que vê dele. */
function shownAs(world: WorldState, c: Character): string {
  const view = perceptionOf(world, world.playerId);
  if (c.isPlayer || view.recognize(c.id)) return c.name;
  return view.sight(c.id) === 'nitido' ? strangerLabel(c) : 'alguém';
}

/** O que o HUD diz dos sentidos do jogador: condições, a luz onde ele está e se carrega uma luz. */
function senseText(world: WorldState): string {
  const p = world.playerId ? world.characters[world.playerId] : null;
  if (!p?.locationId || !p.pos) return '';
  const parts = perceptionOf(world, p.id).conditions.map((d) => d.name);
  const light = lightLabel(lightAt(world, p.locationId, p.pos));
  if (light !== 'claro') parts.push(light === 'escuro' ? '🌑 escuro' : '🌗 penumbra');
  if (lightSources(world, p.locationId).some((s) => s.carrierId === p.id)) parts.push('🔦 luz acesa');
  return parts.join(' · ');
}
