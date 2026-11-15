import { Logger } from '@nestjs/common';
import type {
  AudioFrame,
  AudioSource,
  RemoteParticipant,
  RemoteTrack,
  Room,
} from '@livekit/rtc-node' with { 'resolution-mode': 'import' };
import { OPENAI_PCM_SAMPLE_RATE } from '../speech/openai-tts.service.js';

// Native (napi) module, prebuilt for glibc only: load it when a call starts,
// so the app still boots where it is missing (e.g. an alpine image).
const loadRtc = () => import('@livekit/rtc-node');
type Rtc = Awaited<ReturnType<typeof loadRtc>>;

/** Sample rate the caller's audio is delivered at; what transcription gets. */
export const CALLER_SAMPLE_RATE = 16_000;
/** Sample rate of the bot's published track; matches the TTS output. */
export const PLAYBACK_SAMPLE_RATE = OPENAI_PCM_SAMPLE_RATE;
const PLAYBACK_FRAME_SAMPLES = (PLAYBACK_SAMPLE_RATE * 20) / 1000;
const TRACK_NAME = 'assistant-voice';

export interface CallMediaEvents {
  /** A remote participant's audio track was subscribed; its frames follow. */
  onCallerTrack(identity: string): void;
  /** One frame (10 ms) of the caller's audio, mono at CALLER_SAMPLE_RATE. */
  onCallerFrame(samples: Int16Array): void;
  /** The SFU connection ended without close() being called. */
  onDisconnected(reason: string): void;
}

/**
 * The bot's side of the call on the LiveKit SFU: listens to the caller's
 * microphone track and publishes one audio track to speak on. No E2EE —
 * calls are only taken in unencrypted rooms.
 */
export class MatrixCallMedia {
  private readonly logger = new Logger(MatrixCallMedia.name);
  private rtc: Rtc | undefined;
  private room: Room | undefined;
  private source: AudioSource | undefined;
  private callerReader: ReadableStreamDefaultReader<AudioFrame> | undefined;
  private closed = false;

  constructor(
    private readonly callId: string,
    private readonly events: CallMediaEvents,
  ) {}

  async connect(url: string, jwt: string): Promise<void> {
    const rtc = await loadRtc();
    const room = new rtc.Room();
    this.room = room;
    room.on(rtc.RoomEvent.TrackSubscribed, (track, _publication, participant) =>
      this.onTrackSubscribed(rtc, track, participant),
    );
    room.on(rtc.RoomEvent.Disconnected, (reason) => {
      if (!this.closed) this.events.onDisconnected(`reason ${reason}`);
    });
    await room.connect(url, jwt, { autoSubscribe: true, dynacast: false });

    const source = new rtc.AudioSource(PLAYBACK_SAMPLE_RATE, 1);
    this.source = source;
    const track = rtc.LocalAudioTrack.createAudioTrack(TRACK_NAME, source);
    await room.localParticipant!.publishTrack(
      track,
      new rtc.TrackPublishOptions({
        source: rtc.TrackSource.SOURCE_MICROPHONE,
      }),
    );
    this.rtc = rtc;
  }

  /**
   * Queue mono PCM at PLAYBACK_SAMPLE_RATE for playback. Resolves once the
   * audio is handed to the SFU's buffer (about a second ahead of playout).
   */
  async play(samples: Int16Array): Promise<void> {
    const rtc = this.rtc;
    if (!rtc || !this.source) return;
    for (let at = 0; at < samples.length; at += PLAYBACK_FRAME_SAMPLES) {
      if (this.closed) return;
      // slice, not subarray: the native side reads the frame's whole buffer.
      const data = samples.slice(at, at + PLAYBACK_FRAME_SAMPLES);
      await this.source.captureFrame(
        new rtc.AudioFrame(data, PLAYBACK_SAMPLE_RATE, 1, data.length),
      );
    }
  }

  /** Milliseconds of the bot's audio still waiting to be played out. */
  get playoutRemainingMs(): number {
    return this.source?.queuedDuration ?? 0;
  }

  /** Leave the SFU and release the native resources. Never throws. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.callerReader?.cancel().catch(() => undefined);
    try {
      await this.source?.close();
      await this.room?.disconnect();
    } catch (error) {
      this.logger.warn('Closing the LiveKit connection failed', {
        error: error as Error,
        callId: this.callId,
      });
    }
  }

  private onTrackSubscribed(
    rtc: Rtc,
    track: RemoteTrack,
    participant: RemoteParticipant,
  ): void {
    if (track.kind !== rtc.TrackKind.KIND_AUDIO) return;
    // The call room holds only the caller and the bot, so any other
    // participant's audio is the caller's; the identity is only logged.
    if (participant.identity === this.room?.localParticipant?.identity) return;
    // The caller may republish (e.g. switching to a headset): follow the latest track.
    void this.callerReader?.cancel().catch(() => undefined);
    const stream = new rtc.AudioStream(track, {
      sampleRate: CALLER_SAMPLE_RATE,
      numChannels: 1,
    });
    const reader = stream.getReader();
    this.callerReader = reader;
    this.events.onCallerTrack(participant.identity);
    void this.readCaller(reader);
  }

  private async readCaller(
    reader: ReadableStreamDefaultReader<AudioFrame>,
  ): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.closed) return;
        this.events.onCallerFrame(value.data);
      }
    } catch (error) {
      if (this.closed) return;
      this.logger.warn('Reading the caller audio failed', {
        error: error as Error,
        callId: this.callId,
      });
    }
  }
}
