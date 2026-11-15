import type { OpenaiTtsService } from '../speech/openai-tts.service.js';
import { MatrixCallSpeaker, TURN_END_TONE } from './matrix-call-speaker.js';

jest.mock('./matrix-call-media.js', () => ({ PLAYBACK_SAMPLE_RATE: 24_000 }));

/** A TTS stream yielding one 2-sample chunk tagged with `tag`, after `delayMs`. */
function fakeTts(delays: Record<string, number>) {
  return {
    streamPcm: jest.fn(async function* (text: string) {
      await new Promise((resolve) => setTimeout(resolve, delays[text] ?? 0));
      yield Buffer.from(new Int16Array([text.length, text.length]).buffer);
    }),
  };
}

describe('MatrixCallSpeaker', () => {
  const played: number[][] = [];
  const output = {
    play: jest.fn((samples: Int16Array) => {
      played.push([...samples]);
      return Promise.resolve();
    }),
    onSpeechOut: jest.fn(),
  };

  beforeEach(() => {
    played.length = 0;
    jest.clearAllMocks();
  });

  it('requests speech right away but plays in queue order', async () => {
    const tts = fakeTts({ a: 30, bbb: 0 });
    const speaker = new MatrixCallSpeaker(
      'c1',
      tts as unknown as OpenaiTtsService,
      output,
    );

    speaker.speak('a');
    speaker.speak('bbb');
    expect(tts.streamPcm).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(played).toEqual([
      [1, 1],
      [3, 3],
    ]);
    expect(output.onSpeechOut).toHaveBeenCalledTimes(2);
  });

  it('plays the cue tone in turn with speech', async () => {
    const tts = fakeTts({ a: 20 });
    const speaker = new MatrixCallSpeaker(
      'c1',
      tts as unknown as OpenaiTtsService,
      output,
    );

    speaker.speak('a');
    speaker.playTone();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(played[0]).toEqual([1, 1]);
    expect(played[1]).toHaveLength(TURN_END_TONE.length);
    expect(output.onSpeechOut).toHaveBeenCalledTimes(1);
  });

  it('keeps going after a failed sentence', async () => {
    const working = fakeTts({});
    const tts = {
      streamPcm: jest.fn((text: string) =>
        text === 'a'
          ? (async function* () {
              await Promise.resolve();
              yield* [];
              throw new Error('tts down');
            })()
          : working.streamPcm(text),
      ),
    };
    const speaker = new MatrixCallSpeaker(
      'c1',
      tts as unknown as OpenaiTtsService,
      output,
    );

    speaker.speak('a');
    speaker.speak('bb');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(played).toEqual([[2, 2]]);
  });

  it('plays nothing more once closed', async () => {
    const tts = fakeTts({ a: 20 });
    const speaker = new MatrixCallSpeaker(
      'c1',
      tts as unknown as OpenaiTtsService,
      output,
    );

    speaker.speak('a');
    speaker.close();
    speaker.speak('b');
    speaker.playTone();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(played).toEqual([]);
    expect(tts.streamPcm).toHaveBeenCalledTimes(1);
  });
});
