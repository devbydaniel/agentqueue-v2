import {
  MAX_CHUNK_CHARS,
  SentenceChunker,
  speakable,
} from './sentence-chunker.js';

/** Stream `text` in small pieces, as model deltas arrive. */
function stream(chunker: SentenceChunker, text: string, size = 3): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(...chunker.push(text.slice(i, i + size)));
  }
  return chunks;
}

describe('SentenceChunker', () => {
  let chunker: SentenceChunker;

  beforeEach(() => {
    chunker = new SentenceChunker();
  });

  it('emits each sentence once the next one starts', () => {
    const chunks = stream(
      chunker,
      'Das Wetter morgen wird sonnig. Am Abend regnet es leicht! Noch',
    );
    expect(chunks).toEqual([
      'Das Wetter morgen wird sonnig.',
      'Am Abend regnet es leicht!',
    ]);
    expect(chunker.flush()).toBe('Noch');
    expect(chunker.flush()).toBeUndefined();
  });

  it('waits for whitespace, so decimals and dots inside words do not split', () => {
    expect(chunker.push('Version 3.5 ist da')).toEqual([]);
    expect(chunker.push('.')).toEqual([]);
    expect(chunker.push(' ')).toEqual(['Version 3.5 ist da.']);
  });

  it('merges a very short sentence with the next one', () => {
    expect(stream(chunker, 'Okay. Ich schaue kurz nach. ')).toEqual([
      'Okay. Ich schaue kurz nach.',
    ]);
  });

  it('treats line breaks and closing quotes as boundaries', () => {
    expect(
      stream(
        chunker,
        'Er sagte: "Komm morgen vorbei." Dann ging er.\nZweite Zeile hier\n',
      ),
    ).toEqual([
      'Er sagte: "Komm morgen vorbei."',
      'Dann ging er.',
      'Zweite Zeile hier',
    ]);
  });

  it('cuts a run-on sentence at a comma before it gets too long', () => {
    const long = `${'wort '.repeat(40)}, ${'weiter '.repeat(40)}`;
    const [first] = chunker.push(long);
    expect(first.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(first.endsWith(',')).toBe(true);
  });

  it('cuts at a space when there is no comma', () => {
    const [first] = chunker.push('wort '.repeat(80));
    expect(first.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(first.endsWith('wort')).toBe(true);
  });
});

describe('speakable', () => {
  it('drops markdown markers and collapses whitespace', () => {
    expect(
      speakable('**Wichtig:** das `npm test`\n- erster Punkt\n1. zweiter'),
    ).toBe('Wichtig: das npm test erster Punkt zweiter');
  });

  it('keeps ordinary text unchanged', () => {
    expect(speakable('Um halb vier, am 12. März.')).toBe(
      'Um halb vier, am 12. März.',
    );
  });
});
