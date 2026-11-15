/**
 * Cuts streamed reply text into sentence-sized chunks for speech synthesis,
 * so the first sentence can be spoken while the model is still writing.
 */

/** Chunks shorter than this are merged with the next sentence ("Okay." alone sounds choppy). */
export const MIN_CHUNK_CHARS = 12;
/** A sentence running longer than this is cut at a comma or space. */
export const MAX_CHUNK_CHARS = 300;

const SENTENCE_END = new Set(['.', '!', '?', '…']);
const CLOSING = new Set(['"', "'", ')', ']', '»', '“', '”']);
const SOFT_BREAK = new Set([',', ';', ':', '–', '—']);

export class SentenceChunker {
  private buffer = '';

  /** Add streamed text; returns the chunks it completed, in order. */
  push(delta: string): string[] {
    this.buffer += delta;
    const chunks: string[] = [];
    for (;;) {
      const cut = this.findCut();
      if (cut === undefined) break;
      const chunk = speakable(this.buffer.slice(0, cut));
      this.buffer = this.buffer.slice(cut);
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  /** The text left over at the end of a message, if any. */
  flush(): string | undefined {
    const chunk = speakable(this.buffer);
    this.buffer = '';
    return chunk || undefined;
  }

  /** End of the next complete chunk in the buffer, if there is one. */
  private findCut(): number | undefined {
    const text = this.buffer;
    let i = 0;
    while (i < text.length) {
      const end = boundaryEnd(text, i);
      if (end === undefined) {
        i++;
        continue;
      }
      if (text.slice(0, i).trim().length >= MIN_CHUNK_CHARS) return end;
      i = end;
    }
    if (text.length <= MAX_CHUNK_CHARS) return undefined;
    return lastSoftBreak(text.slice(0, MAX_CHUNK_CHARS)) ?? MAX_CHUNK_CHARS;
  }
}

/**
 * If a sentence ends at `i` — sentence punctuation (plus closing quotes or
 * brackets) followed by whitespace, or a line break — the index after the
 * whitespace. Undefined otherwise, and while the following text is unknown.
 */
function boundaryEnd(text: string, i: number): number | undefined {
  let j = i;
  if (text.charAt(j) !== '\n') {
    if (!SENTENCE_END.has(text.charAt(j))) return undefined;
    while (j < text.length && SENTENCE_END.has(text.charAt(j))) j++;
    while (j < text.length && CLOSING.has(text.charAt(j))) j++;
    if (j >= text.length || !isSpace(text.charAt(j))) return undefined;
  }
  while (j < text.length && isSpace(text.charAt(j))) j++;
  return j;
}

function lastSoftBreak(text: string): number | undefined {
  for (let i = text.length - 2; i > 0; i--) {
    if (SOFT_BREAK.has(text.charAt(i)) && isSpace(text.charAt(i + 1)))
      return i + 2;
  }
  const space = text.lastIndexOf(' ');
  return space > 0 ? space + 1 : undefined;
}

function isSpace(char: string): boolean {
  return char.trim() === '';
}

/**
 * Text as it should be read out: markdown markers the model slipped in
 * despite the voice prompt are dropped, whitespace is collapsed.
 */
export function speakable(text: string): string {
  return text
    .split('\n')
    .map((line) => stripLineMarker(line.trim()))
    .join(' ')
    .replaceAll('`', '')
    .replaceAll('**', '')
    .replaceAll('__', '')
    .replaceAll('*', '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

/** Drop a leading heading or list marker (`# `, `- `, `* `, `• `, `1. `). */
function stripLineMarker(line: string): string {
  const space = line.indexOf(' ');
  if (space <= 0) return line;
  const marker = line.slice(0, space);
  const isMarker =
    /^#+$/.test(marker) ||
    ['-', '*', '•'].includes(marker) ||
    /^\d{1,3}\.$/.test(marker);
  return isMarker ? line.slice(space + 1) : line;
}
