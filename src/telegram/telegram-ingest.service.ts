import { Injectable, Logger } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import {
  interpolateTemplate,
  type TelegramTrigger,
} from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { NEW_SESSION_BUTTON, TelegramService } from './telegram.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

const TELEGRAM_SESSION_IDLE_MS = 60 * 60 * 1000;

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
      return { accepted: true, handled: true };
    }

    const now = new Date();
    const existingSession =
      await this.externalSessionRepository.findBySessionKey(sessionKey);
    const isExpired =
      existingSession?.lastActivityAt &&
      now.getTime() - existingSession.lastActivityAt.getTime() >
        TELEGRAM_SESSION_IDLE_MS;

    if (isExpired) {
      await this.externalSessionRepository.deleteBySessionKey(sessionKey);
      try {
        this.runsService.abortSession(sessionKey);
      } catch (error) {
        this.logger.error('Failed to abort expired Telegram session', {
          error: error as Error,
          sessionKey,
        });
      }
    }

    await this.externalSessionRepository.upsertSession({
      provider: 'telegram',
      sessionKey,
      sessionId: null,
      botName: params.botName,
      chatId: params.chatId,
      messageThreadId: params.messageThreadId,
      lastActivityAt: now,
    });

    this.telegramService.startTypingIndicator({
      sessionKey,
      botToken: trigger.bot_token,
      chatId: params.chatId,
      messageThreadId: params.messageThreadId,
    });

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
    const appendSystemPrompt =
      [triggerAppend, params.extraAppendSystemPrompt]
        .filter((s): s is string => Boolean(s))
        .join('\n\n') || undefined;

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

    return { accepted: true, handled: true };
  }

  private buildSessionKey(
    botName: string,
    chatId: string,
    messageThreadId?: number,
  ): string {
    return `telegram:${botName}:${chatId}:${messageThreadId ?? 'main'}`;
  }
}
