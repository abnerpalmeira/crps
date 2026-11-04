import { actionsFor, type ActionOption } from '../engine/actions';
import { parseSpeechLine } from '../engine/frames';
import type { FreeAct } from '../engine/free';
import { conversationLog, conversationWith, type ConversationEntry } from '../engine/lines';
import { perceptionOf, strangerLabel } from '../engine/perception';
import type { WorldState } from '../engine/types';
import { capitalize, formatNarration, formatPlayerInput, type Speaker } from './format';
import { Portrait } from './portrait';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** O que o painel pede à interface. */
export interface ConversationHooks {
  /** Ação livre no grid: ouvir a próxima fala, responder, ir até a pessoa. */
  free(act: FreeAct): void;
  /** Uma ação do menu da pessoa que vai pela caixa de texto: a marca ou o texto pronto. */
  action(option: ActionOption): void;
  /** "Dizer outra coisa": a caixa de texto, já endereçada a quem está na conversa. */
  say(): void;
  close(): void;
  speaker(id: string): Speaker | null;
  /** O que o inspetor mostra da pessoa, com as regras de percepção, para o "Sobre". */
  card(world: WorldState, id: string): HTMLElement | null;
}

interface Choice {
  label: string;
  className: string;
  run: () => void;
  note?: string;
  disabled?: boolean;
}

/**
 * A conversa com uma pessoa, na coluna da direita, como no Disco Elysium: o retrato dela, o chat
 * dos dois e as opções numeradas (as respostas prontas, continuar, dizer outra coisa, o que mais
 * se faz com ela, encerrar). Tudo sai do mundo: o painel se redesenha a cada estado novo.
 */
export class ConversationPanel {
  private npcId: string | null = null;
  private notice: string | null = null;
  private portrait: Portrait | null = null;
  /** Quantas falas da pessoa o chat já mostrou: uma nova faz o retrato gesticular (-1: acabou de abrir). */
  private spoken = -1;
  private readonly canvas = el('canvas', 'portrait');
  private readonly name = el('h3');
  private readonly role = el('p', 'muted');
  private readonly about = el('details', 'talk-about');
  private readonly log = el('div', 'talk-log');
  private readonly options = el('ol', 'talk-options');

  constructor(
    root: HTMLElement,
    private readonly hooks: ConversationHooks,
  ) {
    const close = el('button', 'close', '×');
    close.type = 'button';
    close.title = 'Encerrar a conversa';
    close.addEventListener('click', () => hooks.close());
    const who = el('div', 'talk-who');
    who.append(this.name, this.role);
    const head = el('div', 'talk-head');
    head.append(this.canvas, who, close);
    root.append(head, this.about, this.log, this.options);
  }

  /** Com quem o jogador está conversando; null com o painel fechado. */
  get with(): string | null {
    return this.npcId;
  }

  open(world: WorldState, npcId: string): void {
    if (this.npcId !== npcId) {
      this.notice = null;
      this.spoken = -1;
      this.about.open = false;
    }
    this.npcId = npcId;
    this.render(world);
  }

  close(): void {
    this.npcId = null;
    this.notice = null;
    this.portrait?.stop();
  }

  /** Um aviso do motor (uma recusa, o tempo que acabou) no fim do chat, até a próxima ação. */
  note(world: WorldState, text: string | null): void {
    this.notice = text;
    this.render(world);
  }

  render(world: WorldState): void {
    const c = this.npcId ? world.characters[this.npcId] : undefined;
    if (!c || !world.playerId) return;
    const known = perceptionOf(world, world.playerId).recognize(c.id);
    this.name.textContent = known ? c.name : capitalize(strangerLabel(c));
    this.role.textContent = known ? c.role : 'Você não sabe quem é.';
    const card = this.hooks.card(world, c.id);
    this.about.replaceChildren(el('summary', '', 'Sobre'), ...(card ? [card] : []));
    this.portrait ??= new Portrait(this.canvas);
    void this.portrait.show(c);

    const entries = conversationLog(world, c.id);
    this.log.replaceChildren(...entries.map((e) => this.line(world, e)));
    if (!entries.length) this.log.append(el('p', 'muted', 'Vocês ainda não conversaram.'));
    if (this.notice) this.log.append(el('p', 'talk-notice', this.notice));
    this.log.scrollTop = this.log.scrollHeight;
    // Fala nova da pessoa: o retrato gesticula, como ela no 3D.
    const spoken = entries.filter((e) => e.kind === 'free' && parseSpeechLine(e.text)?.speakerId === c.id).length;
    if (this.spoken >= 0 && spoken > this.spoken) void this.portrait.talk();
    this.spoken = spoken;
    this.renderOptions(world, c.id);
  }

  /** As teclas 1 a 9 escolhem a opção de mesmo número. */
  choose(n: number): boolean {
    const button = this.options.querySelectorAll<HTMLButtonElement>('button.talk-option')[n - 1];
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }

  private line(world: WorldState, e: ConversationEntry): HTMLElement {
    if (e.kind === 'player') {
      const said = el('div', 'player-line');
      said.innerHTML = formatPlayerInput(e.text, world);
      return said;
    }
    const div = el('div', e.kind === 'narration' ? 'narration talk-narration' : 'narration');
    div.innerHTML = formatNarration(e.text, this.hooks.speaker);
    return div;
  }

  /** As opções numeradas; uma com mais escolhas (que gesto, o que entregar) abre a lista no lugar. */
  private renderOptions(world: WorldState, npcId: string, sub?: ActionOption[]): void {
    const c = world.characters[npcId];
    const choices: Choice[] = [];
    const action = (a: ActionOption): Choice => ({
      label: a.label,
      className: 'act',
      note: a.note,
      disabled: a.disabled,
      run: () => (a.options ? this.renderOptions(world, npcId, a.options) : this.hooks.action(a)),
    });
    if (sub) {
      choices.push({ label: '‹ voltar', className: 'back', run: () => this.renderOptions(world, npcId) });
      choices.push(...sub.map(action));
    } else {
      const talk = conversationWith(c);
      talk.replies.forEach((label, option) => choices.push({ label, className: 'reply', run: () => this.hooks.free({ kind: 'reply', with: npcId, option }) }));
      if (talk.more) choices.push({ label: 'Continuar ▸', className: 'more', run: () => this.hooks.free({ kind: 'talk', with: npcId }) });
      choices.push({ label: '✍ Dizer outra coisa… 🪙', className: 'say', run: () => this.hooks.say() });
      // Conversar e Falar já estão aqui como Continuar e Dizer outra coisa.
      choices.push(...actionsFor(world, { kind: 'character', id: npcId }).filter((a) => a.free?.kind !== 'talk' && a.label !== 'Falar').map(action));
      choices.push({ label: 'Encerrar', className: 'end', run: () => this.hooks.close() });
    }
    this.options.replaceChildren(
      ...choices.map((choice, i) => {
        const button = el('button', `talk-option ${choice.className}`);
        button.type = 'button';
        button.disabled = Boolean(choice.disabled);
        button.append(el('span', 'num', `${i + 1}.`), ` ${choice.label}`);
        if (choice.note) button.append(el('small', 'note', choice.note));
        button.addEventListener('click', choice.run);
        const item = el('li');
        item.append(button);
        return item;
      }),
    );
  }
}
