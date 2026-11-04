import * as THREE from 'three';
import type { Character } from '../engine/types';
import { characterModel, loadAction, type CharacterModel } from './models';
import { buildCharacter } from './props';

/**
 * O retrato de quem conversa com o jogador, como nos jogos de diálogo: cabeça e ombros do mesmo
 * modelo do 3D, num canvas próprio, respirando no idle e gesticulando quando diz uma fala. Um só
 * retrato para o jogo inteiro: fechado, o laço para e a pessoa sai da cena.
 */
export class Portrait {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(24, 1, 0.05, 20);
  private readonly clock = new THREE.Clock();
  private model: CharacterModel | null = null;
  private figure: THREE.Object3D | null = null;
  private showing: string | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // O mesmo acabamento do palco: a pessoa tem no retrato a cor que tem na sala.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const key = new THREE.DirectionalLight('#fff1dc', 2.2);
    key.position.set(-1.2, 2.4, 2.2);
    const rim = new THREE.DirectionalLight('#9fb8ff', 1.6);
    rim.position.set(1.6, 2.2, -2);
    this.scene.add(new THREE.HemisphereLight('#dfe8ff', '#6b5a48', 1.4), key, rim);
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /** Mostra a pessoa; para a mesma pessoa, não refaz nada. */
  async show(c: Character): Promise<void> {
    if (this.showing === c.id) return;
    this.showing = c.id;
    this.clear();
    const model = await characterModel(c).catch(() => null);
    // Trocou de pessoa enquanto o modelo carregava: fica a mais nova.
    if (this.showing !== c.id) return;
    const figure = model?.root ?? buildCharacter(c);
    this.model = model;
    this.figure = figure;
    this.scene.add(figure);
    figure.updateMatrixWorld(true);
    // A câmera mira o rosto: o osso Head fica na base do crânio, e o rosto, uns 10 cm acima; na
    // figura primitiva, a cabeça é a esfera a 1,6 m.
    const head = model?.head?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(0, 1.5, 0);
    this.camera.position.set(head.x + 0.1, head.y + 0.12, head.z + 1.15);
    this.camera.lookAt(head.x, head.y + 0.03, head.z);
    if (model) {
      model.mixer.addEventListener('finished', () => void this.idle(0.3));
      void this.idle(0);
    }
    this.resize();
    this.clock.getDelta();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  /** A pessoa diz uma fala: o gesto de falar uma vez, e de volta ao idle. */
  async talk(): Promise<void> {
    const model = this.model;
    if (!model) return;
    const [idle, talk] = await Promise.all([loadAction(model, 'idle'), loadAction(model, 'talk')]);
    if (!idle || !talk || this.model !== model) return;
    talk.reset();
    talk.setLoop(THREE.LoopOnce, 1);
    talk.play();
    talk.crossFadeFrom(idle, 0.25, false);
  }

  /** Fecha o retrato: o laço para, e a pessoa sai da cena. */
  stop(): void {
    this.renderer.setAnimationLoop(null);
    this.showing = null;
    this.clear();
  }

  private async idle(fade: number): Promise<void> {
    const model = this.model;
    if (!model) return;
    const idle = await loadAction(model, 'idle');
    if (!idle || this.model !== model) return;
    const talk = model.actions.get('talk');
    idle.reset();
    idle.play();
    if (fade && talk?.isRunning()) idle.crossFadeFrom(talk, fade, false);
  }

  private clear(): void {
    this.model?.mixer.stopAllAction();
    if (this.figure) this.scene.remove(this.figure);
    this.model = null;
    this.figure = null;
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private tick(): void {
    this.model?.mixer.update(Math.min(this.clock.getDelta(), 0.1));
    this.renderer.render(this.scene, this.camera);
  }
}
