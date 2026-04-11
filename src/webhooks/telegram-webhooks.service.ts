import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { interpolateTemplate } from '../config/trigger-config.interface.js';
import { RunsService } from '../runs/runs.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { ensureDirectoryExists } from '../common/utils/cwd-path.js';

const TELEGRAM_SESSION_IDLE_MS = 60 * 60 * 1000;

interface TelegramUser {
  id?: number | string;
}

interface TelegramChat {
  id?: number | string;
}

interface TelegramMessage {
  message_id?: number;
  message_thread_id?: number;
  text?: string;
  chat?: TelegramChat;
  from?: TelegramUser;
}

interface TelegramUpdate {
  message?: TelegramMessage;
}

export interface HandleTelegramWebhookParams {
  botName: string;
  secretTokenHeader: string | undefined;
  body: Record<string, unknown>;
}

export interface HandleTelegramWebhookResult {
  accepted: boolean;
  handled: boolean;
}

function toTelegramId(value: number | string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return String(value);
}

function isResetCommand(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '/reset') {
    return true;
  }

  if (!trimmed.startsWith('/reset@')) {
    return false;
  }

  const suffix = trimmed.slice('/reset@'.length);
  return suffix.length > 0 && !suffix.includes(' ');
}

@Injectable()
export class TelegramWebhooksService {
  private readonly logger = new Logger(TelegramWebhooksService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly runsService: RunsService,
    private readonly externalSessionRepository: ExternalSessionRepository,
    private readonly telegramService: TelegramService,
  ) {}

  async handleWebhook(
    params: HandleTelegramWebhookParams,
  ): Promise<HandleTelegramWebhookResult> {
    const botConfig = this.triggerConfigService.getTelegramBotConfig(
      params.botName,
    );
    if (!botConfig) {
      throw new NotFoundException(
        `Telegram webhook not configured for bot '${params.botName}'`,
      );
    }

    if (
      !params.secretTokenHeader ||
      params.secretTokenHeader !== botConfig.webhookSecret
    ) {
      throw new UnauthorizedException('Invalid Telegram webhook secret');
    }

    const update = params.body as TelegramUpdate;
    const message = update.message;
    if (!message?.text || !message.chat || !message.from) {
      return { accepted: true, handled: false };
    }

    const chatId = toTelegramId(message.chat.id);
    const userId = toTelegramId(message.from.id);
    if (!chatId || !userId) {
      return { accepted: true, handled: false };
    }

    const trigger = this.triggerConfigService
      .getTelegramTriggersForBot(params.botName)
      .find(
        (candidate) =>
          candidate.user_id === userId &&
          (!candidate.chat_id || candidate.chat_id === chatId),
      );

    if (!trigger) {
      this.logger.debug('Ignoring Telegram update with no matching trigger', {
        botName: params.botName,
        userId,
        chatId,
      });
      return { accepted: true, handled: false };
    }

    const cwd = ensureDirectoryExists(trigger.cwd, 'telegram trigger cwd');

    const sessionKey = this.buildSessionKey(
      params.botName,
      chatId,
      message.message_thread_id,
    );

    if (isResetCommand(message.text)) {
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
          chatId,
          text: 'Session reset. Send a new message to start fresh.',
          messageThreadId: message.message_thread_id,
          replyToMessageId: message.message_id,
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
      chatId,
      messageThreadId: message.message_thread_id,
      lastActivityAt: now,
    });

    void this.telegramService
      .sendAcknowledgement({
        botToken: trigger.bot_token,
        chatId,
        messageThreadId: message.message_thread_id,
        replyToMessageId: message.message_id,
      })
      .catch((error: unknown) => {
        this.logger.error('Failed to send Telegram acknowledgement', {
          error: error as Error,
          sessionKey,
        });
      });

    const templateVars = {
      botName: params.botName,
      userId,
      chatId,
      triggerName: trigger.name,
      cwd,
    };

    const appendSystemPrompt = trigger.append_system_prompt
      ? interpolateTemplate(trigger.append_system_prompt, templateVars)
      : undefined;

    void this.runsService
      .enqueue({
        source: 'telegram',
        triggerName: trigger.name,
        agentName: trigger.agent,
        cwd,
        prompt: message.text,
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
