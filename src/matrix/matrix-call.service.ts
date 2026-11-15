import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import type { MatrixTrigger } from '../config/trigger-config.interface.js';
import { OpenaiTtsService } from '../speech/openai-tts.service.js';
import { VoxtralTranscriptionService } from '../speech/voxtral-transcription.service.js';
import { TurnDetector } from '../speech/turn-detector.js';
import type { MatrixClient, SyncResponse } from './matrix-client.js';
import { MatrixService } from './matrix.service.js';
import { MatrixActiveCallsService } from './matrix-active-calls.service.js';
import {
  buildLivekitTokenRequest,
  membershipId,
  parseCallMemberships,
} from './matrix-rtc.js';
import { CALLER_SAMPLE_RATE, MatrixCallMedia } from './matrix-call-media.js';
import { MatrixCallMembership } from './matrix-call-membership.js';
import { MatrixCallSpeaker } from './matrix-call-speaker.js';
import {
  callLogIds,
  MatrixCallSessionService,
  type CallContext,
} from './matrix-call-session.service.js';

/** Spoken when the bot has joined, so the caller knows it can hear them. */
export const CALL_GREETING = 'Hi, ich höre.';
const ENCRYPTED_CALL_NOTICE =
  "I can't take calls in an end-to-end encrypted room — I would only hear " +
  'silence. Call me in an unencrypted room.';
const NO_SPEECH_NOTICE =
  "I can't take calls: speech needs OPENAI_API_KEY and MISTRAL_API_KEY.";

interface Call extends CallContext {
  /** LiveKit identities of the caller's devices in the call. */
  callerIdentities: Set<string>;
  startedAt: number;
  /** Resolves once joining finished or gave up; cleanup waits for it. */
  starting: Promise<void>;
  ended: boolean;
  media: MatrixCallMedia;
  speaker: MatrixCallSpeaker;
  membership?: MatrixCallMembership;
  detector: TurnDetector;
  /** Turns are transcribed and handed on one at a time, in order. */
  turns: Promise<void>;
  heardCaller: boolean;
  greetingPending: boolean;
  /** When the caller's last turn ended, until the reply's first audio. */
  turnEndedAt?: number;
}

/**
 * Live MatrixRTC calls with the bot. When the trigger's user joins the call
 * in the trigger's call room, the bot joins too, greets, and listens: each
 * turn goes to MatrixCallSessionService, and the agent's reply is spoken back
 * by MatrixCallCallbackHandler. When the user hangs up, the bot leaves.
 */
@Injectable()
export class MatrixCallService implements OnModuleDestroy {
  private readonly logger = new Logger(MatrixCallService.name);
  /** Calls in progress, by room. */
  private readonly calls = new Map<string, Call>();
  /** The caller's devices in the call, per room: state key → LiveKit identity. */
  private readonly callerMemberships = new Map<string, Map<string, string>>();
  /** Rooms where joining was refused, until the caller leaves. */
  private readonly refused = new Set<string>();

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly matrixService: MatrixService,
    private readonly activeCalls: MatrixActiveCallsService,
    private readonly sessionService: MatrixCallSessionService,
    private readonly ttsService: OpenaiTtsService,
    private readonly transcriptionService: VoxtralTranscriptionService,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.calls.keys()].map((roomId) => this.endCall(roomId, 'shutdown')),
    );
  }

  /** Follow the call memberships in a sync response; join or leave calls. */
  handleSync(botName: string, response: SyncResponse): void {
    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      const trigger = this.triggerConfigService
        .getMatrixTriggersForBot(botName)
        .find((t) => t.call_room_id === roomId);
      if (!trigger) continue;
      const updates = parseCallMemberships(
        [...(room.state?.events ?? []), ...(room.timeline?.events ?? [])],
        Date.now(),
      ).filter((u) => u.sender === trigger.user_id);
      if (updates.length === 0) continue;

      const devices =
        this.callerMemberships.get(roomId) ?? new Map<string, string>();
      for (const update of updates) {
        if (update.livekitIdentity) {
          devices.set(update.stateKey, update.livekitIdentity);
        } else {
          devices.delete(update.stateKey);
        }
      }
      this.callerMemberships.set(roomId, devices);
      this.applyCallerPresence(botName, trigger, roomId, devices);
    }
  }

  private applyCallerPresence(
    botName: string,
    trigger: MatrixTrigger,
    roomId: string,
    devices: Map<string, string>,
  ): void {
    const call = this.calls.get(roomId);
    if (devices.size === 0) {
      this.refused.delete(roomId);
      if (call) void this.endCall(roomId, 'caller left');
      return;
    }
    if (call) {
      for (const identity of devices.values()) {
        call.callerIdentities.add(identity);
      }
      return;
    }
    if (this.refused.has(roomId)) return;
    this.startCall(botName, trigger, roomId, new Set(devices.values()));
  }

  private startCall(
    botName: string,
    trigger: MatrixTrigger,
    roomId: string,
    callerIdentities: Set<string>,
  ): void {
    const id = randomUUID().slice(0, 8);
    // The media and speaker callbacks only run once the call is set up.
    const call: Call = {
      id,
      botName,
      roomId,
      trigger,
      callerIdentities,
      startedAt: Date.now(),
      starting: Promise.resolve(),
      ended: false,
      media: new MatrixCallMedia(
        id,
        {
          onCallerTrack: (identity) =>
            this.logger.log('Caller audio track subscribed', {
              ...callLogIds(call),
              identity,
            }),
          onCallerFrame: (samples) => this.onCallerFrame(call, samples),
          onDisconnected: (reason) =>
            void this.endCall(roomId, `LiveKit disconnected (${reason})`),
        },
        (identity) => call.callerIdentities.has(identity),
      ),
      speaker: new MatrixCallSpeaker(id, this.ttsService, {
        play: (samples) => call.media.play(samples),
        onSpeechOut: () => this.onSpeechOut(call),
      }),
      detector: new TurnDetector(CALLER_SAMPLE_RATE),
      turns: Promise.resolve(),
      heardCaller: false,
      greetingPending: true,
    };
    this.calls.set(roomId, call);
    this.logger.log('Caller joined the call; joining', callLogIds(call));
    call.starting = this.joinCall(call).catch(async (error: unknown) => {
      this.logger.error('Failed to join the call', {
        error: error as Error,
        ...callLogIds(call),
      });
      await this.sessionService.notice(
        call,
        `⚠️ Couldn't join the call: ${String(error)}`,
      );
      this.refused.add(roomId);
      void this.endCall(roomId, 'join failed');
    });
  }

  /** Steps stop early once the caller hangs up; endCall cleans up after. */
  private async joinCall(call: Call): Promise<void> {
    const client = this.matrixService.getClient(call.botName)!;
    const userId = this.matrixService.getUserId(call.botName);
    const deviceId = this.matrixService.getDeviceId(call.botName);
    if (!userId || !deviceId) throw new Error('bot user or device unknown');
    const problem = await this.joinProblem(call, client);
    if (problem) {
      await this.refuse(call, problem);
      return;
    }

    await this.sessionService.openThread(call);
    if (this.hungUp(call)) return;
    const jwt = await client.getLivekitToken(
      buildLivekitTokenRequest(
        call.trigger.livekit_url!,
        call.roomId,
        membershipId(userId, deviceId),
      ),
    );
    this.logger.log('LiveKit token obtained', callLogIds(call));
    if (this.hungUp(call)) return;
    await call.media.connect(call.trigger.livekit_internal_url!, jwt);
    this.logger.log('LiveKit connected', callLogIds(call));
    if (this.hungUp(call)) return;

    call.membership = new MatrixCallMembership(client, {
      callId: call.id,
      roomId: call.roomId,
      userId,
      deviceId,
      livekitUrl: call.trigger.livekit_url!,
    });
    await call.membership.join();
    this.logger.log('Call membership posted', callLogIds(call));
    if (this.hungUp(call)) return;
    this.activeCalls.register(call.sessionKey!, call.speaker);
    call.speaker.speak(CALL_GREETING);
  }

  /** Why the bot can't take part in the call, if it can't. */
  private async joinProblem(
    call: Call,
    client: MatrixClient,
  ): Promise<string | undefined> {
    if (
      !this.ttsService.isAvailable() ||
      !this.transcriptionService.isAvailable()
    ) {
      return NO_SPEECH_NOTICE;
    }
    // With per-participant E2EE the bot would only receive ciphertext.
    if (await client.isRoomEncrypted(call.roomId)) return ENCRYPTED_CALL_NOTICE;
    return undefined;
  }

  /** Say why once; don't try again until the caller has left. */
  private async refuse(call: Call, problem: string): Promise<void> {
    this.logger.warn(`Refusing the call: ${problem}`, callLogIds(call));
    await this.sessionService.notice(call, problem);
    this.refused.add(call.roomId);
    void this.endCall(call.roomId, 'refused');
  }

  /** Whether the call ended meanwhile (a method, so checks across awaits aren't narrowed away). */
  private hungUp(call: Call): boolean {
    return call.ended;
  }

  private onCallerFrame(call: Call, samples: Int16Array): void {
    if (call.ended) return;
    const utterance = call.detector.push(samples);
    if (!call.heardCaller && call.detector.inTurn) {
      call.heardCaller = true;
      this.logger.log('First speech from the caller', {
        ...callLogIds(call),
        level: Number(call.detector.lastLevel.toFixed(3)),
      });
    }
    if (!utterance) return;
    call.turnEndedAt = Date.now();
    call.speaker.playTone();
    this.logger.log('Turn ended', {
      ...callLogIds(call),
      durationMs: Math.round(utterance.durationMs),
      speechMs: Math.round(utterance.speechMs),
      truncated: utterance.truncated,
    });
    call.turns = call.turns
      .then(() => this.sessionService.handleTurn(call, utterance))
      .catch((error: unknown) => {
        this.logger.error('Failed to handle a call turn', {
          error: error as Error,
          ...callLogIds(call),
        });
      });
  }

  /** Logs the latency that matters: from the end of a turn to the first reply audio. */
  private onSpeechOut(call: Call): void {
    const now = Date.now();
    if (call.greetingPending) {
      call.greetingPending = false;
      this.logger.log('First TTS audio out (greeting)', {
        ...callLogIds(call),
        sinceCallStartMs: now - call.startedAt,
      });
      return;
    }
    if (call.turnEndedAt === undefined) return;
    this.logger.log('First TTS audio out', {
      ...callLogIds(call),
      sinceTurnEndMs: now - call.turnEndedAt,
    });
    call.turnEndedAt = undefined;
  }

  /** Leave the call and release everything it holds. Never throws. */
  private async endCall(roomId: string, reason: string): Promise<void> {
    const call = this.calls.get(roomId);
    if (!call || call.ended) return;
    call.ended = true;
    await call.starting;
    this.calls.delete(roomId);
    if (call.sessionKey) {
      this.activeCalls.unregister(call.sessionKey, call.speaker);
    }
    call.speaker.close();
    call.detector.reset();
    await call.media.close();
    await call.membership?.leave();
    this.logger.log('Call ended', {
      ...callLogIds(call),
      reason,
      durationS: Math.round((Date.now() - call.startedAt) / 1000),
    });
  }
}
