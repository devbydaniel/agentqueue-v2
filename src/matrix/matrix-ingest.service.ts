import { Injectable, Logger } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import {
  interpolateTemplate,
  type MatrixTrigger,
} from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { VoxtralTranscriptionService } from '../telegram/voxtral-transcription.service.js';
import { VOICE_SYSTEM_PROMPT } from '../telegram/telegram-ingest.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';
import { MatrixService, type MatrixTarget } from './matrix.service.js';
import { MatrixMediaService } from './matrix-media.service.js';
import { buildSessionKey, type InboundMessage } from './matrix-content.js';

const MATRIX_SYSTEM_PROMPT = `
You are responding via Matrix (Element). Your reply is rendered as markdown:
headings, bold/italic, lists, code blocks, links and tables all display
properly. Keep it reasonably concise — it is often read on a phone.
`.trim();

const MAX_CONTEXT_CHARS = 4000;

type VoiceCommand = 'on' | 'off' | 'toggle';

function parseVoiceCommand(text: string): VoiceCommand | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized === '!voice') return 'toggle';
  if (normalized === '!voice on') return 'on';
  if (normalized === '!voice off') return 'off';
  return undefined;
}

export interface MatrixIngestBatch {
  botName: string;
  roomId: string;
  /** Undefined for messages sent at the top level of the room. */
  threadRootId: string | undefined;
  /** Consecutive messages for one session, oldest first. */
  messages: InboundMessage[];
}

/**
 * Turns inbound Matrix messages into agent runs, one session per thread. A
 * message at the top level of a room starts a new thread (and session) rooted
 * at itself; the reply and all follow-ups live in that thread.
 */
@Injectable()
export class MatrixIngestService {
  private readonly logger = new Logger(MatrixIngestService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly matrixService: MatrixService,
    private readonly mediaService: MatrixMediaService,
    private readonly transcriptionService: VoxtralTranscriptionService,
  ) {}

  /** The trigger allowing `sender` to talk to `botName` in `roomId`, if any. */
  resolveTrigger(
    botName: string,
    sender: string,
    roomId: string,
  ): MatrixTrigger | undefined {
    return this.triggerConfigService
      .getMatrixTriggersForBot(botName)
      .find(
        (t) => t.user_id === sender && (!t.room_id || t.room_id === roomId),
      );
  }

  async ingest(batch: MatrixIngestBatch): Promise<void> {
    const sender = batch.messages[0]?.sender;
    const trigger =
      sender && this.resolveTrigger(batch.botName, sender, batch.roomId);
    if (!trigger) {
      this.logger.debug('Ignoring Matrix message with no matching trigger', {
        botName: batch.botName,
        sender,
        roomId: batch.roomId,
      });
      return;
    }

    const command =
      batch.messages.length === 1 && batch.messages[0].kind === 'text'
        ? parseVoiceCommand(batch.messages[0].text ?? '')
        : undefined;
    if (command) {
      // Commands are answered where they were sent, without opening a thread.
      await this.runVoiceCommand(command, {
        botName: batch.botName,
        roomId: batch.roomId,
        threadRootId: batch.threadRootId,
      });
      return;
    }

    // A top-level message opens its own thread: one session per thread.
    if (!batch.threadRootId) {
      batch = { ...batch, threadRootId: batch.messages[0].eventId };
    }
    const target: MatrixTarget = {
      botName: batch.botName,
      roomId: batch.roomId,
      threadRootId: batch.threadRootId,
    };
    const sessionKey = buildSessionKey(
      batch.botName,
      batch.roomId,
      batch.threadRootId,
    );

    const prompt = await this.composePrompt(batch, target, sessionKey);
    if (!prompt) return;

    const cwd = ensureDirectoryExists(trigger.cwd, 'matrix trigger cwd');
    await this.externalSessionRepository.upsertSession({
      provider: 'matrix',
      sessionKey,
      sessionId: null,
      botName: batch.botName,
      chatId: batch.roomId,
      lastActivityAt: new Date(),
    });
    this.matrixService.startTyping(sessionKey);

    await this.enqueueRun(trigger, batch, target, sessionKey, prompt, cwd);
  }

  private async enqueueRun(
    trigger: MatrixTrigger,
    batch: MatrixIngestBatch,
    target: MatrixTarget,
    sessionKey: string,
    prompt: string,
    cwd: string,
  ): Promise<void> {
    const voiceEnabled = await this.matrixService.isVoiceEnabled(
      batch.botName,
      batch.roomId,
    );
    try {
      await this.runsService.enqueue({
        source: 'matrix',
        triggerName: trigger.name,
        agentName: trigger.agent,
        cwd,
        prompt,
        externalSessionId: sessionKey,
        appendSystemPrompt: this.buildSystemPrompt(
          trigger,
          batch,
          cwd,
          voiceEnabled,
        ),
        timeoutMs: trigger.timeout_ms,
      });
    } catch (error) {
      this.logger.error('Failed to enqueue Matrix run', {
        error: error as Error,
        sessionKey,
      });
      this.matrixService.stopTyping(sessionKey);
      await this.notice(
        target,
        '⚠️ Failed to enqueue your request. Please try again.',
      );
    }
  }

  private async runVoiceCommand(
    command: VoiceCommand,
    target: MatrixTarget,
  ): Promise<void> {
    const current = await this.matrixService.isVoiceEnabled(
      target.botName,
      target.roomId,
    );
    const enabled = command === 'toggle' ? !current : command === 'on';
    try {
      await this.matrixService.setVoiceEnabled(
        target.botName,
        target.roomId,
        enabled,
      );
    } catch (error) {
      this.logger.error('Failed to store Matrix voice mode', {
        error: error as Error,
      });
      await this.notice(target, '⚠️ Could not change voice mode.');
      return;
    }
    await this.notice(
      target,
      enabled
        ? 'Voice mode ON for this room — replies come as voice and text.'
        : 'Voice mode OFF for this room — replies are text only.',
    );
  }

  private async composePrompt(
    batch: MatrixIngestBatch,
    target: MatrixTarget,
    sessionKey: string,
  ): Promise<string> {
    const sections: string[] = [];
    const context = await this.describeContext(batch, sessionKey);
    if (context) sections.push(context);
    for (const message of batch.messages) {
      const part = await this.describeMessage(message, target);
      if (part) sections.push(part);
    }
    return sections.join('\n\n').trim();
  }

  /**
   * What the user is responding to: the start of a thread on its first
   * message, or an explicitly quoted message. This is how a reply to a
   * cron-posted message reaches the agent with that message as context.
   */
  private async describeContext(
    batch: MatrixIngestBatch,
    sessionKey: string,
  ): Promise<string | undefined> {
    const own = new Set(batch.messages.map((m) => m.eventId));
    const first = batch.messages[0];
    let eventId = first.replyToEventId;
    let label = 'The user is replying to this earlier message';
    if (
      !eventId &&
      batch.threadRootId &&
      !(await this.externalSessionRepository.findBySessionKey(sessionKey))
    ) {
      eventId = batch.threadRootId;
      label = 'This thread was started from this message';
    }
    if (!eventId || own.has(eventId)) return undefined;

    try {
      const client = this.matrixService.getClient(batch.botName)!;
      const event = await client.getEvent(batch.roomId, eventId);
      const body = event.content['body'];
      if (typeof body !== 'string' || !body) return undefined;
      const author =
        event.sender === this.matrixService.getUserId(batch.botName)
          ? 'you'
          : 'the user';
      return `[${label} (written by ${author})]:\n${body.slice(0, MAX_CONTEXT_CHARS)}`;
    } catch (error) {
      this.logger.warn('Failed to fetch Matrix context event', {
        error: error as Error,
        eventId,
      });
      return undefined;
    }
  }

  private async describeMessage(
    message: InboundMessage,
    target: MatrixTarget,
  ): Promise<string | undefined> {
    if (message.kind === 'text') return message.text;

    const client = this.matrixService.getClient(target.botName)!;
    let localPath: string;
    try {
      localPath = await this.mediaService.download(
        client,
        message.mediaUrl!,
        message.fileName,
        message.mimeType,
      );
    } catch (error) {
      this.logger.error('Failed to download Matrix media', {
        error: error as Error,
        eventId: message.eventId,
      });
      await this.notice(target, `⚠️ Failed to download ${message.kind}.`);
      return message.text;
    }

    const caption = message.text ? `\n${message.text}` : '';
    if (message.kind === 'image') return `[Image: ${localPath}]${caption}`;
    if (message.kind === 'file') return `[File: ${localPath}]${caption}`;
    return this.transcribe(localPath, target, caption);
  }

  private async transcribe(
    localPath: string,
    target: MatrixTarget,
    caption: string,
  ): Promise<string | undefined> {
    if (!this.transcriptionService.isAvailable()) {
      await this.notice(
        target,
        'Voice transcription disabled (MISTRAL_API_KEY not set).',
      );
      return caption.trim() || undefined;
    }
    try {
      const transcript = (
        await this.transcriptionService.transcribe(localPath)
      ).trim();
      if (!transcript) {
        await this.notice(target, 'Could not transcribe the voice message.');
        return caption.trim() || undefined;
      }
      await this.notice(target, `🎤 ${transcript}`);
      return `[Voice message transcription]: ${transcript}${caption}`;
    } catch (error) {
      this.logger.error('Failed to transcribe Matrix audio', {
        error: error as Error,
      });
      await this.notice(target, '⚠️ Failed to transcribe audio.');
      return caption.trim() || undefined;
    }
  }

  private buildSystemPrompt(
    trigger: MatrixTrigger,
    batch: MatrixIngestBatch,
    cwd: string,
    voiceEnabled: boolean,
  ): string {
    const triggerAppend = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, {
          botName: batch.botName,
          userId: trigger.user_id,
          roomId: batch.roomId,
          triggerName: trigger.name,
          cwd,
        })
      : undefined;
    return [
      triggerAppend,
      MATRIX_SYSTEM_PROMPT,
      voiceEnabled ? VOICE_SYSTEM_PROMPT : undefined,
    ]
      .filter((s): s is string => Boolean(s))
      .join('\n\n');
  }

  private async notice(target: MatrixTarget, text: string): Promise<void> {
    try {
      await this.matrixService.sendNotice(target, text);
    } catch (error) {
      this.logger.error('Failed to send Matrix notice', {
        error: error as Error,
        roomId: target.roomId,
      });
    }
  }
}
