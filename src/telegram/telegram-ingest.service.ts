import { Injectable, Logger } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import {
  interpolateTemplate,
  type TelegramTrigger,
} from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import {
  NEW_SESSION_BUTTON,
  TelegramService,
  VOICE_OFF_BUTTON,
  VOICE_ON_BUTTON,
} from './telegram.service.js';
import { TelegramChatSettingsRepository } from './telegram-chat-settings.repository.js';
import { OpenaiTtsService } from './openai-tts.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

export const VOICE_SYSTEM_PROMPT = `
The user has voice mode ON — your reply will be read aloud as a voice message.
Write for the ear, not the eye:

- Keep it short and conversational, as if speaking
- Plain sentences only — NO markdown, headings, tables, bullet lists, or code blocks
- Avoid raw URLs, file paths, and long identifiers; describe them instead
- If something genuinely needs code or a link, say so briefly — the full text is sent alongside the audio
`.trim();

/** Returns the requested voice state, or null when the text isn't a voice command. */
function parseVoiceToggleCommand(text: string): 'on' | 'off' | 'toggle' | null {
  const trimmed = text.trim();
  if (trimmed === VOICE_ON_BUTTON || trimmed === VOICE_OFF_BUTTON) {
    return 'toggle';
  }
  const lower = trimmed.toLowerCase();
  if (lower === '/voice') return 'toggle';
  if (lower === '/voice on') return 'on';
  if (lower === '/voice off') return 'off';
  return null;
}

export interface IngestMessageParams {
  botName: string;
  chatId: string;
  userId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
  text: string;
  /** Extra system-prompt lines appended by the caller (e.g. poller formatting guidance). Merged with the trigger's append_system_prompt. */
  extraAppendSystemPrompt?: string;
}

export interface IngestMessageResult {
  accepted: boolean;
  handled: boolean;
}

function isResetCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '/reset') return true;
  if (trimmed === NEW_SESSION_BUTTON) return true;
  if (!trimmed.startsWith('/reset@')) return false;
  const suffix = trimmed.slice('/reset@'.length);
  return suffix.length > 0 && !suffix.includes(' ');
}

@Injectable()
export class TelegramIngestService {
  private readonly logger = new Logger(TelegramIngestService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly telegramService: TelegramService,
    private readonly chatSettingsRepository: TelegramChatSettingsRepository,
    private readonly ttsService: OpenaiTtsService,
  ) {}

  resolveTrigger(
    botName: string,
    userId: string,
    chatId: string,
  ): TelegramTrigger | undefined {
    return this.triggerConfigService
      .getTelegramTriggersForBot(botName)
      .find(
        (candidate) =>
          candidate.user_id === userId &&
          (!candidate.chat_id || candidate.chat_id === chatId),
      );
  }

  async ingestMessage(
    params: IngestMessageParams,
  ): Promise<IngestMessageResult> {
    const trigger = this.resolveTrigger(
      params.botName,
      params.userId,
      params.chatId,
    );
    if (!trigger) {
      this.logger.debug('Ignoring Telegram message with no matching trigger', {
        botName: params.botName,
        userId: params.userId,
        chatId: params.chatId,
      });
      return { accepted: true, handled: false };
    }

    const cwd = ensureDirectoryExists(trigger.cwd, 'telegram trigger cwd');
    const sessionKey = this.buildSessionKey(
      params.botName,
      params.chatId,
      params.messageThreadId,
    );

    if (isResetCommand(params.text)) {
      await this.handleResetCommand(trigger, params, sessionKey);
      return { accepted: true, handled: true };
    }

    const voiceCommand = parseVoiceToggleCommand(params.text);
    if (voiceCommand) {
      await this.handleVoiceToggleCommand(
        trigger,
        params,
        sessionKey,
        voiceCommand,
      );
      return { accepted: true, handled: true };
    }

    await this.externalSessionRepository.upsertSession({
      provider: 'telegram',
      sessionKey,
      sessionId: null,
      botName: params.botName,
      chatId: params.chatId,
      messageThreadId: params.messageThreadId,
      lastActivityAt: new Date(),
    });

    this.telegramService.startTypingIndicator({
      sessionKey,
      botToken: trigger.bot_token,
      chatId: params.chatId,
      messageThreadId: params.messageThreadId,
    });

    const voiceEnabled =
      await this.chatSettingsRepository.isVoiceEnabled(sessionKey);
    const appendSystemPrompt = this.buildAppendSystemPrompt(
      trigger,
      params,
      cwd,
      voiceEnabled,
    );

    this.enqueueRun(trigger, params, sessionKey, cwd, appendSystemPrompt);

    return { accepted: true, handled: true };
  }

  private async handleVoiceToggleCommand(
    trigger: TelegramTrigger,
    params: IngestMessageParams,
    sessionKey: string,
    command: 'on' | 'off' | 'toggle',
  ): Promise<void> {
    const current =
      await this.chatSettingsRepository.isVoiceEnabled(sessionKey);
    const enabled = command === 'toggle' ? !current : command === 'on';
    await this.chatSettingsRepository.setVoiceEnabled(sessionKey, enabled);

    let text = enabled
      ? 'Voice mode ON — I will reply with a voice message (and text).'
      : 'Voice mode OFF — replies are text only.';
    if (enabled && !this.ttsService.isAvailable()) {
      text +=
        '\n\n⚠️ OPENAI_API_KEY is not set, so replies will stay text-only until it is configured.';
    }

    await this.telegramService
      .sendDirectMessage({
        botToken: trigger.bot_token,
        chatId: params.chatId,
        text,
        messageThreadId: params.messageThreadId,
        replyToMessageId: params.replyToMessageId,
        voiceModeEnabled: enabled,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to send Telegram voice-toggle confirmation', {
          error: error as Error,
          sessionKey,
        });
      });
  }

  private async handleResetCommand(
    trigger: TelegramTrigger,
    params: IngestMessageParams,
    sessionKey: string,
  ): Promise<void> {
    await this.externalSessionRepository.deleteBySessionKey(sessionKey);
    try {
      this.runsService.abortSession(sessionKey);
    } catch (error) {
      this.logger.error('Failed to abort Telegram session during reset', {
        error: error as Error,
        sessionKey,
      });
    }
    void this.telegramService
      .sendDirectMessage({
        botToken: trigger.bot_token,
        chatId: params.chatId,
        text: 'Session reset. Send a new message to start fresh.',
        messageThreadId: params.messageThreadId,
        replyToMessageId: params.replyToMessageId,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to send Telegram reset confirmation', {
          error: error as Error,
          sessionKey,
        });
      });
  }

  private buildAppendSystemPrompt(
    trigger: TelegramTrigger,
    params: IngestMessageParams,
    cwd: string,
    voiceEnabled: boolean,
  ): string | undefined {
    const templateVars = {
      botName: params.botName,
      userId: params.userId,
      chatId: params.chatId,
      triggerName: trigger.name,
      cwd,
    };

    const triggerAppend = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, templateVars)
      : undefined;
    return (
      [
        triggerAppend,
        params.extraAppendSystemPrompt,
        voiceEnabled ? VOICE_SYSTEM_PROMPT : undefined,
      ]
        .filter((s): s is string => Boolean(s))
        .join('\n\n') || undefined
    );
  }

  private enqueueRun(
    trigger: TelegramTrigger,
    params: IngestMessageParams,
    sessionKey: string,
    cwd: string,
    appendSystemPrompt: string | undefined,
  ): void {
    void this.runsService
      .enqueue({
        source: 'telegram',
        triggerName: trigger.name,
        agentName: trigger.agent,
        cwd,
        prompt: params.text,
        externalSessionId: sessionKey,
        appendSystemPrompt,
        timeoutMs: trigger.timeout_ms,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to enqueue Telegram run', {
          error: error as Error,
          sessionKey,
        });
        void this.telegramService.emitRunError(
          trigger.name,
          sessionKey,
          'Failed to enqueue your request. Please try again.',
        );
      });
  }

  private buildSessionKey(
    botName: string,
    chatId: string,
    messageThreadId?: number,
  ): string {
    return `telegram:${botName}:${chatId}:${messageThreadId ?? 'main'}`;
  }
}
