import { Injectable, Logger } from '@nestjs/common';
import type { MatrixTrigger } from '../config/trigger-config.interface.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { VoxtralTranscriptionService } from '../speech/voxtral-transcription.service.js';
import { encodeWav } from '../speech/pcm-audio.js';
import type { Utterance } from '../speech/turn-detector.js';
import { MatrixService, type MatrixTarget } from './matrix.service.js';
import { MatrixIngestService } from './matrix-ingest.service.js';
import { buildSessionKey } from './matrix-content.js';

const CALL_ROOT_TEXT = '📞 Call';

export const CALL_SYSTEM_PROMPT = `
You are responding via Matrix (Element X), in a live voice call with the user.
Everything you write is read aloud by text-to-speech as you write it.
- Answer in the language the user speaks.
- Keep each answer to two or three short sentences. Offer more detail rather
  than giving it unasked.
- Plain spoken sentences only: no markdown, lists, tables, code, URLs or emoji.
- Write numbers, dates and times the way they are spoken.
- Before tool work that takes a while, say one short sentence about what you
  are doing.
- If something is too long to say (a list, a draft, a link, code), say so in one
  sentence and post it as a separate text message into this conversation's
  Matrix thread instead of reading it out.
`.trim();

/** What the agent side needs to know about a call. */
export interface CallContext {
  /** Short id that ties the log lines of one call together. */
  id: string;
  botName: string;
  roomId: string;
  trigger: MatrixTrigger;
  /** The call's thread, once opened. */
  target?: MatrixTarget;
  sessionKey?: string;
}

/**
 * The agent session of a call: one thread per call, rooted in a "📞 Call"
 * message, so the user can carry on by text afterwards. Each turn of the
 * caller is transcribed, echoed into the thread and handed to the agent —
 * steered into the run in progress, or as a new run.
 */
@Injectable()
export class MatrixCallSessionService {
  private readonly logger = new Logger(MatrixCallSessionService.name);

  constructor(
    private readonly matrixService: MatrixService,
    private readonly ingestService: MatrixIngestService,
    private readonly runsService: RunsService,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly transcriptionService: VoxtralTranscriptionService,
  ) {}

  /** Post the call's root message and make its thread the call's session. */
  async openThread(call: CallContext): Promise<void> {
    const client = this.matrixService.getClient(call.botName)!;
    const rootId = await client.sendMessage(call.roomId, {
      msgtype: 'm.notice',
      body: CALL_ROOT_TEXT,
    });
    call.target = {
      botName: call.botName,
      roomId: call.roomId,
      threadRootId: rootId,
    };
    call.sessionKey = buildSessionKey(call.botName, call.roomId, rootId);
    await this.touchSession(call);
  }

  async handleTurn(call: CallContext, utterance: Utterance): Promise<void> {
    const startedAt = Date.now();
    const transcript = (
      await this.transcriptionService.transcribeAudio(
        encodeWav(utterance.samples, utterance.sampleRate),
        'turn.wav',
        'audio/wav',
      )
    ).trim();
    this.logger.log('Transcript received', {
      ...callLogIds(call),
      chars: transcript.length,
      transcribeMs: Date.now() - startedAt,
    });
    if (!transcript) return;

    await this.notice(call, `🎤 ${transcript}`);
    await this.touchSession(call);
    const prompt = `[Live call, the user said]: ${transcript}`;
    if (await this.runsService.steerSession(call.sessionKey!, prompt)) {
      this.logger.log('Steered the run in progress', callLogIds(call));
      return;
    }
    await this.enqueueRun(call, prompt);
  }

  /** A status line in the call's thread (or the room, before it exists). Never throws. */
  async notice(call: CallContext, text: string): Promise<void> {
    try {
      await this.matrixService.sendNotice(
        call.target ?? {
          botName: call.botName,
          roomId: call.roomId,
          threadRootId: undefined,
        },
        text,
      );
    } catch (error) {
      this.logger.error('Failed to send a call notice', {
        error: error as Error,
        ...callLogIds(call),
      });
    }
  }

  private async enqueueRun(call: CallContext, prompt: string): Promise<void> {
    const { trigger } = call;
    const sessionKey = call.sessionKey!;
    const cwd = ensureDirectoryExists(trigger.cwd, 'matrix trigger cwd');
    this.matrixService.startTyping(sessionKey);
    try {
      const { runId } = await this.runsService.enqueue({
        source: 'matrix',
        triggerName: trigger.name,
        cwd,
        prompt,
        externalSessionId: sessionKey,
        appendSystemPrompt: [
          this.ingestService.triggerSystemPrompt(trigger, call.roomId, cwd),
          CALL_SYSTEM_PROMPT,
        ]
          .filter(Boolean)
          .join('\n\n'),
        timeoutMs: trigger.timeout_ms,
        queue: trigger.queue,
      });
      this.logger.log('Run enqueued', { ...callLogIds(call), runId });
    } catch (error) {
      this.matrixService.stopTyping(sessionKey);
      throw error;
    }
  }

  private async touchSession(call: CallContext): Promise<void> {
    await this.externalSessionRepository.upsertSession({
      provider: 'matrix',
      sessionKey: call.sessionKey!,
      sessionId: null,
      botName: call.botName,
      chatId: call.roomId,
      lastActivityAt: new Date(),
    });
  }
}

/** Log fields identifying a call. */
export function callLogIds(call: CallContext): {
  callId: string;
  roomId: string;
} {
  return { callId: call.id, roomId: call.roomId };
}
