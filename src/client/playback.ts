import { labelMenuActs } from '../engine/actions';
import { parseActs } from '../engine/body';
import { parseBeats, parseSpeechLine, sceneAt, type Beat } from '../engine/frames';
import type { Clock, SceneFrame, WorldState } from '../engine/types';
import { capitalize, readable, speechHtml } from './format';
import type { WorldView } from './scene';

/** Um turno da campanha visto como frame: a ação do jogador e as falas e narrações, em ordem. */
export interface Frame {
  turn: number;
  beats: Beat[];
  scene?: SceneFrame;
}

export interface PlaybackState {
  turn: number | null;
  beat: number;
  beats: number;
  playing: boolean;
  /** A cena na tela é um retrato do passado, não o estado atual. */
  replaying: boolean;
  /** Relógio do retrato em exibição (null ao vivo ou sem retrato). */
  clock: Clock | null;
  hasFrames: boolean;
  canPrevFrame: boolean;
  canNextFrame: boolean;
}

export interface PlaybackUi {
  caption(text: string | null, who?: string): void;
  controls(state: PlaybackState): void;
}

export function buildFrames(world: WorldState): Frame[] {
  const turns = new Map<number, { input: string | null; narration: string | null; free: string[] }>();
  for (const e of world.log) {
    const t = turns.get(e.turn) ?? { input: null, narration: null, free: [] };
    if (e.kind === 'player') t.input = e.text;
    if (e.kind === 'narration') t.narration = e.text;
    // As falas prontas que o jogador ouviu no grid vêm depois da narração do turno.
    if (e.kind === 'free' && parseSpeechLine(e.text)) t.free.push(e.text);
    turns.set(e.turn, t);
  }
  const frames: Frame[] = [];
  for (const [turn, t] of turns) {
    if (!t.narration) continue;
    const input: Beat[] = t.input ? [{ kind: 'input', text: t.input }] : [];
    frames.push({ turn, beats: [...input, ...parseBeats(t.narration), ...parseBeats(t.free.join('\n'))], scene: world.frames.find((f) => f.turn === turn) });
  }
  return frames;
}

/** Tempo de leitura de cada passo. */
function duration(beat: Beat): number {
  const [base, perChar] = beat.kind === 'speech' ? [1400, 55] : beat.kind === 'input' ? [1800, 30] : [1800, 42];
  return Math.min(9000, base + perChar * beat.text.length);
}

/** Toca os frames na cena 3D: balões sobre quem fala, legenda para o resto. */
export class Playback {
  private world: WorldState | null = null;
  private frames: Frame[] = [];
  private index = -1;
  private beat = -1;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Turno cujo retrato está na tela; null quando a cena é o estado atual. */
  private sceneTurn: number | null = null;

  constructor(
    private readonly view: WorldView,
    private readonly ui: PlaybackUi,
    private readonly nameOf: (id: string) => string | null,
  ) {}

  setWorld(world: WorldState): void {
    this.world = world;
    const turn = this.frames[this.index]?.turn;
    this.frames = buildFrames(world);
    if (turn !== undefined) this.index = this.frames.findIndex((f) => f.turn === turn);
    if (this.sceneTurn === null) this.view.setWorld(world);
    this.emit();
  }

  playTurn(turn: number): void {
    const i = this.frames.findIndex((f) => f.turn === turn);
    if (i >= 0) this.go(i, 0, true);
  }

  playLatest(): void {
    if (this.frames.length) this.go(this.frames.length - 1, 0, true);
  }

  /** Mostra só o último passo do turno atual (a fala de uma conversa livre), sem tocar o resto. */
  showLast(): void {
    const i = this.frames.length - 1;
    if (i < 0) return;
    this.go(i, this.frames[i].beats.length - 1, false);
    // Na conversa livre, só o balão de quem acabou de falar: as falas da narração não voltam.
    const last = this.frames[i].beats.at(-1);
    if (last?.kind === 'speech') this.view.setBalloons([{ speakerId: last.speakerId, html: speechHtml(last), mode: last.mode, age: 0 }]);
  }

  toggle(): void {
    if (this.playing) return this.pause();
    if (this.index < 0) return this.playLatest();
    // No fim do frame, o play recomeça do início dele.
    this.go(this.index, this.beat >= this.frames[this.index].beats.length - 1 ? 0 : this.beat, true);
  }

  pause(): void {
    this.playing = false;
    this.clearTimer();
    this.emit();
  }

  next(): void {
    this.step(1);
  }

  prev(): void {
    this.step(-1);
  }

  nextFrame(): void {
    if (this.index >= 0 && this.index < this.frames.length - 1) this.go(this.index + 1, 0, this.playing);
  }

  prevFrame(): void {
    if (this.index < 0) this.go(this.frames.length - 1, 0, false);
    else if (this.index > 0) this.go(this.index - 1, 0, this.playing);
  }

  /** Volta ao estado atual do mundo, sem balões nem legenda. */
  live(): void {
    this.clearTimer();
    this.playing = false;
    this.index = -1;
    this.beat = -1;
    this.view.setBalloons([]);
    this.ui.caption(null);
    if (this.sceneTurn !== null && this.world) this.view.setWorld(this.world);
    this.sceneTurn = null;
    this.emit();
  }

  private step(delta: number): void {
    if (this.index < 0) {
      if (this.frames.length) this.go(this.frames.length - 1, 0, false);
      return;
    }
    let i = this.index;
    let b = this.beat + delta;
    if (b >= this.frames[i].beats.length) {
      if (i + 1 >= this.frames.length) return;
      i += 1;
      b = 0;
    } else if (b < 0) {
      if (i === 0) return;
      i -= 1;
      b = this.frames[i].beats.length - 1;
    }
    this.go(i, b, this.playing);
  }

  private go(index: number, beat: number, playing: boolean): void {
    if (!this.frames[index]) return;
    this.index = index;
    this.beat = beat;
    this.playing = playing;
    this.render();
    this.schedule();
    this.emit();
  }

  private schedule(): void {
    this.clearTimer();
    const frame = this.frames[this.index];
    if (!this.playing || !frame) return;
    this.timer = setTimeout(() => {
      if (this.beat < frame.beats.length - 1) this.go(this.index, this.beat + 1, true);
      else this.pause();
    }, duration(frame.beats[this.beat]));
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private render(): void {
    const frame = this.frames[this.index];
    if (!frame || !this.world) return;
    const turn = this.index === this.frames.length - 1 ? null : frame.turn;
    if (turn !== this.sceneTurn) {
      this.sceneTurn = turn;
      this.view.setWorld(turn === null ? this.world : sceneAt(this.world, frame.scene));
    }
    const shown = frame.beats.slice(0, this.beat + 1);
    const current = shown.at(-1);
    // Até três falas na tela: a atual em destaque, as anteriores esmaecendo.
    const speeches = shown.filter((b): b is Extract<Beat, { kind: 'speech' }> => b.kind === 'speech').slice(-3);
    const offset = current?.kind === 'speech' ? 0 : 1;
    const missing = this.view.setBalloons(
      speeches.map((s, k) => ({ speakerId: s.speakerId, html: speechHtml(s), mode: s.mode, age: speeches.length - 1 - k + offset })),
    );
    if (!current) this.ui.caption(null);
    else if (current.kind === 'input') this.ui.caption(labelMenuActs(current.text, this.world), 'Você');
    else if (current.kind === 'narration') this.ui.caption(readable(current.text) || null);
    else if (missing.includes(current.speakerId)) {
      const who = current.alias ? capitalize(current.alias) : (this.nameOf(current.speakerId) ?? current.speakerId);
      this.ui.caption(current.hidden ? `🤫 ${readable(current.text)}` : readable(current.text), who);
    }
    else this.ui.caption(null);
    // Os gestos marcados neste passo acontecem agora no 3D.
    if (current && current.kind !== 'input') this.view.act(parseActs(current.text));
  }

  private emit(): void {
    const frame = this.frames[this.index];
    this.ui.controls({
      turn: frame?.turn ?? null,
      beat: frame ? this.beat + 1 : 0,
      beats: frame?.beats.length ?? 0,
      playing: this.playing,
      replaying: this.sceneTurn !== null,
      clock: this.sceneTurn !== null ? (frame?.scene?.clock ?? null) : null,
      hasFrames: this.frames.length > 0,
      canPrevFrame: this.frames.length > 0 && this.index !== 0,
      canNextFrame: this.index >= 0 && this.index < this.frames.length - 1,
    });
  }
}
