import { Injectable, Logger } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_MESSAGE_CHUNK_SIZE = 4000;

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
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly externalSessionRepository: ExternalSessionRepository,
  ) {}

  async sendAcknowledgement(params: {
    botToken: string;
    chatId: string;
    messageThreadId?: number;
    replyToMessageId?: number;
  }): Promise<void> {
    await this.sendMessage(params.botToken, {
      chat_id: params.chatId,
      text: 'Queued. I will reply here when it is done.',
      ...(params.messageThreadId !== undefined
        ? { message_thread_id: params.messageThreadId }
        : {}),
      ...(params.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: params.replyToMessageId } }
        : {}),
    });
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
    const trigger = this.triggerConfigService.getTelegramTrigger(triggerName);
    if (!trigger) {
      this.logger.warn(`Telegram trigger "${triggerName}" not found`);
      return;
    }

    const session = await this.externalSessionRepository.findBySessionKey(
      sessionKey,
    );
    if (!session || session.provider !== 'telegram' || !session.chatId) {
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
    for (const chunk of chunks) {
      await this.sendMessage(botToken, {
        chat_id: chatId,
        text: chunk,
        ...(options.messageThreadId !== undefined
          ? { message_thread_id: options.messageThreadId }
          : {}),
        ...(options.replyToMessageId !== undefined
          ? { reply_parameters: { message_id: options.replyToMessageId } }
          : {}),
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
