import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_MESSAGE_CHUNK_SIZE = 4000;
// Telegram expires a chat action after 5s, so we refresh well before that.
const TYPING_REFRESH_INTERVAL_MS = 4000;

export const NEW_SESSION_BUTTON = '🆕 New Session';

const PERSISTENT_KEYBOARD = {
  keyboard: [[{ text: NEW_SESSION_BUTTON }]],
  resize_keyboard: true,
  is_persistent: true,
};

function chunkMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_CHUNK_SIZE) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    let next = remaining.slice(0, TELEGRAM_MESSAGE_CHUNK_SIZE);
    if (remaining.length > TELEGRAM_MESSAGE_CHUNK_SIZE) {
      const splitAt = next.lastIndexOf('\n');
      if (splitAt > 0) {
        next = next.slice(0, splitAt);
      }
    }
    chunks.push(next);
    remaining = remaining.slice(next.length).trimStart();
  }

  return chunks;
}

@Injectable()
export class TelegramService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly externalSessionRepository: ExternalSessionRepository,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
  }

  startTypingIndicator(params: {
    sessionKey: string;
    botToken: string;
    chatId: string;
    messageThreadId?: number;
  }): void {
    this.stopTypingIndicator(params.sessionKey);

    const fire = (): void => {
      void this.sendChatAction(params.botToken, params.chatId, {
        messageThreadId: params.messageThreadId,
      }).catch((error: unknown) => {
        this.logger.debug('Telegram typing action failed', {
          error: error as Error,
          sessionKey: params.sessionKey,
        });
      });
    };

    // Fire immediately so the user sees the indicator without waiting a tick
    fire();
    const timer = setInterval(fire, TYPING_REFRESH_INTERVAL_MS);
    this.typingTimers.set(params.sessionKey, timer);
  }

  stopTypingIndicator(sessionKey: string): void {
    const timer = this.typingTimers.get(sessionKey);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(sessionKey);
    }
  }

  async sendDirectMessage(params: {
    botToken: string;
    chatId: string;
    text: string;
    messageThreadId?: number;
    replyToMessageId?: number;
  }): Promise<void> {
    await this.sendChunkedText(params.botToken, params.chatId, params.text, {
      messageThreadId: params.messageThreadId,
      replyToMessageId: params.replyToMessageId,
    });
  }

  async emitRunResponse(
    triggerName: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    await this.emitForRun(triggerName, sessionKey, message);
  }

  async emitRunError(
    triggerName: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    await this.emitForRun(triggerName, sessionKey, message);
  }

  private async emitForRun(
    triggerName: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    // Always stop the typing indicator; the response (or error) replaces it.
    this.stopTypingIndicator(sessionKey);

    const trigger = this.triggerConfigService.getTelegramTrigger(triggerName);
    if (!trigger) {
      this.logger.warn(`Telegram trigger "${triggerName}" not found`);
      return;
    }

    const session =
      await this.externalSessionRepository.findBySessionKey(sessionKey);
    if (session?.provider !== 'telegram' || !session.chatId) {
      this.logger.debug('Skipping Telegram reply because session is missing', {
        triggerName,
        sessionKey,
      });
      return;
    }

    await this.sendChunkedText(trigger.bot_token, session.chatId, message, {
      messageThreadId: session.messageThreadId ?? undefined,
    });
  }

  private async sendChatAction(
    botToken: string,
    chatId: string,
    options: { messageThreadId?: number } = {},
  ): Promise<void> {
    const response = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${botToken}/sendChatAction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          action: 'typing',
          ...(options.messageThreadId !== undefined
            ? { message_thread_id: options.messageThreadId }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API sendChatAction failed (${response.status}): ${errorText}`,
      );
    }
  }

  private async sendChunkedText(
    botToken: string,
    chatId: string,
    text: string,
    options: {
      messageThreadId?: number;
      replyToMessageId?: number;
    },
  ): Promise<void> {
    const chunks = chunkMessage(text);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await this.sendMessage(botToken, {
        chat_id: chatId,
        // eslint-disable-next-line security/detect-object-injection -- i is our own numeric loop counter
        text: chunks[i],
        ...(options.messageThreadId !== undefined
          ? { message_thread_id: options.messageThreadId }
          : {}),
        ...(options.replyToMessageId !== undefined
          ? { reply_parameters: { message_id: options.replyToMessageId } }
          : {}),
        ...(isLast ? { reply_markup: PERSISTENT_KEYBOARD } : {}),
      });
    }
  }

  private async sendMessage(
    botToken: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API sendMessage failed (${response.status}): ${errorText}`,
      );
    }
  }
}
