import {
  END_OF_TURN_SILENCE_MS,
  MAX_TURN_MS,
  PRE_ROLL_MS,
  TurnDetector,
  type Utterance,
} from './turn-detector.js';

const RATE = 16_000;
const FRAME_MS = 10;
const FRAME = (RATE * FRAME_MS) / 1000;

const loud = (): Int16Array => new Int16Array(FRAME).fill(4_000);
const quiet = (): Int16Array => new Int16Array(FRAME).fill(20);

/** Push `ms` of frames; returns the utterances completed along the way. */
function feed(
  detector: TurnDetector,
  frame: () => Int16Array,
  ms: number,
): Utterance[] {
  const done: Utterance[] = [];
  for (let t = 0; t < ms; t += FRAME_MS) {
    const utterance = detector.push(frame());
    if (utterance) done.push(utterance);
  }
  return done;
}

describe('TurnDetector', () => {
  let detector: TurnDetector;

  beforeEach(() => {
    detector = new TurnDetector(RATE);
  });

  it('stays idle on silence', () => {
    expect(feed(detector, quiet, 5_000)).toEqual([]);
    expect(detector.inTurn).toBe(false);
  });

  it('ends a turn after the trailing silence, keeping the pre-roll', () => {
    feed(detector, quiet, 1_000);
    expect(feed(detector, loud, 1_000)).toEqual([]);
    expect(detector.inTurn).toBe(true);

    const beforeEnd = feed(detector, quiet, END_OF_TURN_SILENCE_MS - FRAME_MS);
    expect(beforeEnd).toEqual([]);
    const [utterance] = feed(detector, quiet, FRAME_MS);

    expect(utterance.speechMs).toBe(1_000);
    expect(utterance.durationMs).toBe(
      PRE_ROLL_MS + 1_000 + END_OF_TURN_SILENCE_MS,
    );
    expect(utterance.samples).toHaveLength(
      (utterance.durationMs * RATE) / 1000,
    );
    expect(utterance.sampleRate).toBe(RATE);
    expect(utterance.truncated).toBe(false);
    expect(detector.inTurn).toBe(false);
  });

  it('bridges pauses shorter than the end-of-turn silence', () => {
    feed(detector, loud, 500);
    feed(detector, quiet, 400);
    feed(detector, loud, 500);
    const [utterance] = feed(detector, quiet, END_OF_TURN_SILENCE_MS);
    expect(utterance.speechMs).toBe(1_400);
  });

  it('drops utterances shorter than the minimum (a cough, a click)', () => {
    feed(detector, loud, 200);
    expect(feed(detector, quiet, 2_000)).toEqual([]);
    expect(detector.inTurn).toBe(false);
  });

  it('cuts a turn that runs past the maximum', () => {
    const utterances = feed(detector, loud, MAX_TURN_MS + 1_000);
    expect(utterances).toHaveLength(1);
    expect(utterances[0].truncated).toBe(true);
    expect(utterances[0].durationMs).toBe(MAX_TURN_MS);
    // The rest of the speech starts the next turn.
    expect(detector.inTurn).toBe(true);
  });

  it('reports the level of the last frame', () => {
    detector.push(loud());
    expect(detector.lastLevel).toBeCloseTo(4_000 / 32_767, 3);
  });

  it('forgets a turn in progress on reset', () => {
    feed(detector, loud, 500);
    detector.reset();
    expect(detector.inTurn).toBe(false);
    expect(feed(detector, quiet, 2_000)).toEqual([]);
  });
});
