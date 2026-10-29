import { parseSpeechLine, type ParsedSpeech } from '../engine/frames';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** **negrito** e *itálico* (gestos nas falas); o texto é escapado antes. */
export function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(“"])[*_](\S(?:.*?\S)?)[*_](?=[\s.,;:!?)”"]|$)/g, '$1<em>$2</em>');
}

/** Conteúdo de uma fala; a que o jogador não ouviu aparece só como gesto. */
export function speechHtml(speech: Pick<ParsedSpeech, 'text' | 'hidden'>): string {
  return speech.hidden ? `<em class="hidden-speech">🤫 ${escapeHtml(speech.text)}</em>` : inline(speech.text);
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
      const who = speaker(speech.speakerId);
      const style = who ? ` style="color:${who.color}"` : '';
      const to = speech.targetId ? (speaker(speech.targetId)?.name.split(' ')[0] ?? speech.targetId) : null;
      const how = [speech.mode !== 'fala' ? speech.mode : '', to ? `→ ${to}` : ''].filter(Boolean).join(' ');
      const tag = how && !speech.hidden ? ` <span class="speech-mode">${escapeHtml(how)}</span>` : '';
      const via = speech.via ? ` <span class="speech-via" title="você percebeu graças a este perk">✦ ${escapeHtml(speech.via)}</span>` : '';
      html.push(`<p class="speech"><b${style}>${escapeHtml(who?.name ?? speech.speakerId)}</b>${tag}${via} ${speechHtml(speech)}</p>`);
    } else if (line.trim()) paragraph.push(line);
    else flush();
  }
  flush();
  return html.join('');
}
