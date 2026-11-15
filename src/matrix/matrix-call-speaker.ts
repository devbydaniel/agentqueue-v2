import { Logger } from '@nestjs/common';
import type { OpenaiTtsService } from '../speech/openai-tts.service.js';
import { samplesFromBytes, synthesizeTone } from '../speech/pcm-audio.js';
import type { CallVoice } from './matrix-active-calls.service.js';
import { PLAYBACK_SAMPLE_RATE } from './matrix-call-media.js';

/** Cue played when the caller's turn ends, so they know they were heard. */
export const TURN_END_TONE = synthesizeTone({
  sampleRate: PLAYBACK_SAMPLE_RATE,
  frequencyHz: 880,
  durationMs: 150,
  amplitude: 0.15,
  fadeMs: 20,
});

export interface CallSpeakerOutput {
  /** Queue PCM at PLAYBACK_SAMPLE_RATE; resolves when it is buffered for playout. */
  play(samples: Int16Array): Promise<void>;
  /** Called when the first audio of a sentence goes out. */
  onSpeechOut(): void;
}

/**
 * Plays sentences and cues into the call strictly in the order they are
 * queued. Speech for each sentence is requested as soon as it is queued and
 * streamed, so the next sentence is ready by the time the current one ends.
 */
export class MatrixCallSpeaker implements CallVoice {
  private readonly logger = new Logger(MatrixCallSpeaker.name);
  private readonly abortController = new AbortController();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly callId: string,
    private readonly tts: OpenaiTtsService,
    private readonly output: CallSpeakerOutput,
  ) {}

  private get closed(): boolean {
    return this.abortController.signal.aborted;
  }

  speak(text: string): void {
    if (this.closed) return;
    const speech = PrefetchedSpeech.start(
      this.tts.streamPcm(text, this.abortController.signal),
    );
    this.enqueue(async () => {
      let first = true;
      for await (const samples of speech.read()) {
        if (this.closed) return;
        if (first) this.output.onSpeechOut();
        first = false;
        await this.output.play(samples);
      }
    });
  }

  playTone(): void {
    if (this.closed) return;
    this.enqueue(() => this.output.play(TURN_END_TONE));
  }

  /** Drop everything queued and stop requesting speech. */
  close(): void {
    this.abortController.abort();
  }

  private enqueue(job: () => Promise<void>): void {
    this.chain = this.chain.then(job).catch((error: unknown) => {
      if (this.closed) return;
      this.logger.error('Call playback failed', {
        error: error as Error,
        callId: this.callId,
      });
    });
  }
}

/**
 * Reads a speech stream eagerly into memory, so synthesis runs ahead while
 * earlier sentences are still playing; `read()` replays it as it arrives.
 */
class PrefetchedSpeech {
  private readonly chunks: Int16Array[] = [];
  private done = false;
  private error: Error | undefined;
  private wake: (() => void) | undefined;

  static start(source: AsyncIterable<Buffer>): PrefetchedSpeech {
    const speech = new PrefetchedSpeech();
    void speech.fill(source);
    return speech;
  }

  async *read(): AsyncGenerator<Int16Array> {
    for (;;) {
      const next = this.chunks.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private async fill(source: AsyncIterable<Buffer>): Promise<void> {
    try {
      for await (const bytes of source) {
        this.chunks.push(samplesFromBytes(bytes));
        this.notify();
      }
    } catch (error) {
      this.error = error instanceof Error ? error : new Error(String(error));
    } finally {
      this.done = true;
      this.notify();
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
