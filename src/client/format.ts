import { stripActs } from '../engine/body';
import { parseSpeechLine, type ParsedSpeech } from '../engine/frames';
import { hasMarks, parsePlayerInput, type InputSegment } from '../engine/input';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** **negrito** e *itálico* (gestos nas falas); o texto é escapado antes. */
export function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(“"])[*_](\S(?:.*?\S)?)[*_](?=[\s.,;:!?)”"]|$)/g, '$1<em>$2</em>');
}

/**
 * O texto como o jogador lê: sem as marcas de gesto (`{id:gesto}`), que o 3D anima, nem a marca
 * que ainda está chegando no fim da linha enquanto a narração é escrita.
 */
export function readable(text: string): string {
  return stripActs(text.replace(/\{[^{}]*$/, ''));
}

/** Conteúdo de uma fala; a que o jogador não ouviu aparece só como gesto. */
export function speechHtml(speech: Pick<ParsedSpeech, 'text' | 'hidden'>): string {
  const text = readable(speech.text);
  return speech.hidden ? `<em class="hidden-speech">🤫 ${escapeHtml(text)}</em>` : inline(text);
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export interface Speaker {
  name: string;
  color: string;
}

/** Narração em parágrafos e falas (`@id[modo>alvo]: texto`) com o nome de quem fala. */
export function formatNarration(text: string, speaker: (id: string) => Speaker | null): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  for (const line of text.trim().split('\n')) {
    const speech = parseSpeechLine(line);
    if (speech) {
      flush();
      // Quem o jogador não sabe quem é vem sem nome e sem a cor do personagem, que o entregaria.
      const who = speech.alias ? null : speaker(speech.speakerId);
      const name = speech.alias ? capitalize(speech.alias) : (who?.name ?? speech.speakerId);
      const style = who ? ` style="color:${who.color}"` : speech.alias ? ' class="unknown"' : '';
      const to = speech.targetId ? (speech.toAlias ?? speaker(speech.targetId)?.name.split(' ')[0] ?? speech.targetId) : null;
      const how = [speech.mode !== 'fala' ? speech.mode : '', to ? `→ ${to}` : ''].filter(Boolean).join(' ');
      const tag = how && !speech.hidden ? ` <span class="speech-mode">${escapeHtml(how)}</span>` : '';
      const via = speech.via ? ` <span class="speech-via" title="você percebeu graças a este perk">✦ ${escapeHtml(speech.via)}</span>` : '';
      html.push(`<p class="speech"><b${style}>${escapeHtml(name)}</b>${tag}${via} ${speechHtml(speech)}</p>`);
    } else if (readable(line)) paragraph.push(readable(line));
    else if (!line.trim()) flush();
  }
  flush();
  return html.join('');
}

export const INPUT_ICON: Record<InputSegment['kind'], string> = { fala: '💬', sussurro: '🤫', pensamento: '💭', acao: '✋' };

/** A ação do jogador com as marcas destacadas; sem marcas, o texto como ele escreveu. */
export function formatPlayerInput(text: string): string {
  const segments = parsePlayerInput(text);
  if (!hasMarks(segments)) return escapeHtml(text);
  return segments
    .map((s) => {
      const t = escapeHtml(s.text);
      if (s.kind === 'fala') return `<span class="in-say">“${t}”</span>`;
      if (s.kind === 'sussurro') return `<span class="in-whisper">🤫 ${escapeHtml(s.target ?? '')}: “${t}”</span>`;
      if (s.kind === 'pensamento') return `<span class="in-think">💭 ${t}</span>`;
      return `<span class="in-act">${t}</span>`;
    })
    .join(' ');
}
