import { SPEECH_LINE } from '../engine/frames';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** **negrito** e *itálico* (gestos nas falas); o texto é escapado antes. */
export function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(“"])[*_](\S(?:.*?\S)?)[*_](?=[\s.,;:!?)”"]|$)/g, '$1<em>$2</em>');
}

export interface Speaker {
  name: string;
  color: string;
}

/** Narração em parágrafos e falas (`@id: texto`) com o nome de quem fala. */
export function formatNarration(text: string, speaker: (id: string) => Speaker | null): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  for (const line of text.trim().split('\n')) {
    const speech = SPEECH_LINE.exec(line);
    if (speech) {
      flush();
      const who = speaker(speech[1].toLowerCase());
      const style = who ? ` style="color:${who.color}"` : '';
      html.push(`<p class="speech"><b${style}>${escapeHtml(who?.name ?? speech[1])}</b> ${inline(speech[2])}</p>`);
    } else if (line.trim()) paragraph.push(line);
    else flush();
  }
  flush();
  return html.join('');
}
