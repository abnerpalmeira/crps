import { parseSpeechLine } from './frames';
import { distanceBetween, perceivesSpeech, speechPerks } from './perception';
import type { WorldState } from './types';

/** Uma fala da narração, já conferida pelo motor. */
export interface SpeechLine {
  /** Índice da linha na narração. */
  index: number;
  speakerId: string;
  mode: string;
  targetId: string | null;
  text: string;
  /** Quem percebeu o conteúdo (por som, lábios, mente…), inclusive quem falou. */
  hearers: string[];
  /** Alguém presente ficou sem ouvir: a fala é conhecimento restrito. */
  restricted: boolean;
}

/**
 * Confere as falas da narração contra o mundo: quem fala existe, o modo existe, o alvo está ao
 * alcance do modo (cochichar exige estar colado) e quem, dos presentes, percebe o conteúdo.
 */
export function analyzeSpeech(world: WorldState, narration: string): { issues: string[]; lines: SpeechLine[] } {
  const issues: string[] = [];
  const lines: SpeechLine[] = [];
  narration.split('\n').forEach((raw, index) => {
    const p = parseSpeechLine(raw);
    if (!p || p.hidden) return;
    const speaker = world.characters[p.speakerId];
    if (!speaker) {
      issues.push(`A fala "@${p.speakerId}" usa um id que não existe; use o id do personagem que fala.`);
      return;
    }
    const mode = world.ruleset.speech[p.mode];
    if (!mode) {
      issues.push(`${speaker.name} fala no modo "${p.mode}", que não existe (modos: ${Object.keys(world.ruleset.speech).join(', ')}); crie com extend_ruleset ou use um existente.`);
      return;
    }
    const target = p.targetId ? world.characters[p.targetId] : null;
    if (p.targetId && !target) {
      issues.push(`${speaker.name} fala com "${p.targetId}", id que não existe.`);
      return;
    }
    let targetInReach = false;
    if (target) {
      const d = distanceBetween(world, speaker.id, target.id);
      if (d === null) issues.push(`${speaker.name} ${mode.label} para ${target.name}, mas os dois não estão no mesmo local.`);
      else if (d > mode.reach) {
        issues.push(
          `${speaker.name} ${mode.label} para ${target.name} a ${d} tiles de distância, e "${p.mode}" exige até ${mode.reach}. ` +
            `Aproxime os dois com move_character antes, ou troque a ação.`,
        );
      } else targetInReach = true;
    }
    const present = Object.values(world.characters).filter((c) => c.locationId && c.locationId === speaker.locationId);
    const hearers = present
      .filter((c) => (c.id === target?.id && targetInReach) || perceivesSpeech(world, c.id, speaker.id, mode))
      .map((c) => c.id);
    if (!hearers.includes(speaker.id)) hearers.unshift(speaker.id);
    lines.push({ index, speakerId: speaker.id, mode: p.mode, targetId: target?.id ?? null, text: p.text, hearers, restricted: present.some((c) => !hearers.includes(c.id)) });
  });
  return { issues, lines };
}

/** O que o jogador vê de uma fala que não ouviu: só o gesto. */
export function hiddenSpeech(world: WorldState, line: Pick<SpeechLine, 'speakerId' | 'mode' | 'targetId'>): string {
  const label = world.ruleset.speech[line.mode]?.label ?? 'fala';
  const target = line.targetId ? world.characters[line.targetId] : null;
  const marker = `${line.mode}${line.targetId ? `>${line.targetId}` : ''}|oculto`;
  return `@${line.speakerId}[${marker}]: ${label} algo${target ? ` para ${target.name.split(' ')[0]}` : ''}`;
}

/**
 * A narração como o jogador a percebe: falas que ele não ouviu viram só o gesto, e as que ele só
 * percebeu graças a um perk (um cochicho para outro, por telepatia) dizem qual.
 */
export function playerNarration(world: WorldState, narration: string): string {
  const viewer = world.playerId;
  if (!viewer) return narration;
  const lines = new Map(analyzeSpeech(world, narration).lines.map((l) => [l.index, l]));
  return narration
    .split('\n')
    .map((raw, i) => {
      const line = lines.get(i);
      if (!line) return raw;
      if (!line.hearers.includes(viewer)) return hiddenSpeech(world, line);
      if (line.targetId === viewer) return raw;
      const perks = speechPerks(world, viewer, line.speakerId, world.ruleset.speech[line.mode]);
      if (!perks.length) return raw;
      const via = perks.map((p) => p.name.replace(/[\]|]/g, '')).join(', ');
      return `@${line.speakerId}[${line.mode}${line.targetId ? `>${line.targetId}` : ''}|via ${via}]: ${line.text}`;
    })
    .join('\n');
}
