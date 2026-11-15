import { concatSamples, rmsLevel } from './pcm-audio.js';

/**
 * Energy-based turn detection for a live call: a frame louder than the
 * threshold is speech, and a long enough pause ends the speaker's turn. The
 * caller's client (Element X) applies noise suppression and gain control, so
 * a plain level threshold separates speech from silence well enough.
 */

/** RMS level (0–1) above which a frame counts as speech, about -36 dBFS. */
export const SPEECH_RMS_THRESHOLD = 0.016;
/** Silence after speech that ends the turn. */
export const END_OF_TURN_SILENCE_MS = 700;
/** Turns with less speech than this (coughs, clicks) are dropped. */
export const MIN_UTTERANCE_MS = 300;
/** A turn is cut off and handed on after this long, even mid-sentence. */
export const MAX_TURN_MS = 60_000;
/** Audio kept from before the first loud frame, so the first syllable is not clipped. */
export const PRE_ROLL_MS = 200;

export interface Utterance {
  samples: Int16Array;
  sampleRate: number;
  /** Length of the audio handed on, pre-roll and trailing silence included. */
  durationMs: number;
  /** From the first to the last loud frame. */
  speechMs: number;
  /** True if the turn hit MAX_TURN_MS instead of ending in a pause. */
  truncated: boolean;
}

export interface TurnDetectorOptions {
  threshold: number;
  endOfTurnSilenceMs: number;
  minUtteranceMs: number;
  maxTurnMs: number;
  preRollMs: number;
}

export const DEFAULT_TURN_DETECTOR_OPTIONS: TurnDetectorOptions = {
  threshold: SPEECH_RMS_THRESHOLD,
  endOfTurnSilenceMs: END_OF_TURN_SILENCE_MS,
  minUtteranceMs: MIN_UTTERANCE_MS,
  maxTurnMs: MAX_TURN_MS,
  preRollMs: PRE_ROLL_MS,
};

interface Turn {
  frames: Int16Array[];
  durationMs: number;
  /** Duration up to and including the last loud frame. */
  lastSpeechEndMs: number;
  speechStartMs: number;
  silenceMs: number;
}

/**
 * Segments a stream of mono PCM frames into utterances. Time is measured in
 * samples, not wall clock, so the result only depends on the audio.
 */
export class TurnDetector {
  private preRoll: Int16Array[] = [];
  private preRollMs = 0;
  private turn: Turn | undefined;
  private level = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly options: TurnDetectorOptions = DEFAULT_TURN_DETECTOR_OPTIONS,
  ) {}

  /** RMS level of the last frame pushed. */
  get lastLevel(): number {
    return this.level;
  }

  /** Whether a turn is in progress (speech heard, end not yet detected). */
  get inTurn(): boolean {
    return this.turn !== undefined;
  }

  /** Feed one frame; returns the utterance if this frame completes a turn. */
  push(frame: Int16Array): Utterance | undefined {
    const frameMs = (frame.length / this.sampleRate) * 1000;
    this.level = rmsLevel(frame);
    const loud = this.level >= this.options.threshold;

    if (!this.turn) {
      if (loud) this.startTurn(frame, frameMs);
      else this.keepPreRoll(frame, frameMs);
      return undefined;
    }

    const turn = this.turn;
    turn.frames.push(frame);
    turn.durationMs += frameMs;
    if (loud) {
      turn.silenceMs = 0;
      turn.lastSpeechEndMs = turn.durationMs;
    } else {
      turn.silenceMs += frameMs;
    }

    if (turn.silenceMs >= this.options.endOfTurnSilenceMs) {
      return this.endTurn(false);
    }
    if (turn.durationMs >= this.options.maxTurnMs) return this.endTurn(true);
    return undefined;
  }

  /** Drop any turn in progress, e.g. when the call ends. */
  reset(): void {
    this.turn = undefined;
    this.preRoll = [];
    this.preRollMs = 0;
  }

  private startTurn(frame: Int16Array, frameMs: number): void {
    const speechStartMs = this.preRollMs;
    this.turn = {
      frames: [...this.preRoll, frame],
      durationMs: speechStartMs + frameMs,
      lastSpeechEndMs: speechStartMs + frameMs,
      speechStartMs,
      silenceMs: 0,
    };
    this.preRoll = [];
    this.preRollMs = 0;
  }

  private keepPreRoll(frame: Int16Array, frameMs: number): void {
    this.preRoll.push(frame);
    this.preRollMs += frameMs;
    while (this.preRoll.length > 1) {
      const oldestMs = (this.preRoll[0].length / this.sampleRate) * 1000;
      if (this.preRollMs - oldestMs < this.options.preRollMs) break;
      this.preRoll.shift();
      this.preRollMs -= oldestMs;
    }
  }

  private endTurn(truncated: boolean): Utterance | undefined {
    const turn = this.turn!;
    this.turn = undefined;
    const speechMs = turn.lastSpeechEndMs - turn.speechStartMs;
    if (speechMs < this.options.minUtteranceMs) return undefined;
    return {
      samples: concatSamples(turn.frames),
      sampleRate: this.sampleRate,
      durationMs: turn.durationMs,
      speechMs,
      truncated,
    };
  }
}
