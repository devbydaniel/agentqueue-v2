import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { OpenaiTtsService } from './openai-tts.service.js';
import { TelegramChatSettingsRepository } from './telegram-chat-settings.repository.js';

const TELEGRAM_API_BASE_URL = 'https://api.telegram.org';
const TELEGRAM_MESSAGE_CHUNK_SIZE = 4000;
// Telegram expires a chat action after 5s, so we refresh well before that.
const TYPING_REFRESH_INTERVAL_MS = 4000;

export const NEW_SESSION_BUTTON = '🆕 New Session';
// The voice toggle button shows the CURRENT state; tapping the shown label flips it.
export const VOICE_ON_BUTTON = '🔊 Voice: on';
export const VOICE_OFF_BUTTON = '🔇 Voice: off';

function buildKeyboard(voiceEnabled: boolean): {
  keyboard: { text: string }[][];
  resize_keyboard: boolean;
  is_persistent: boolean;
} {
  return {
    keyboard: [
      [{ text: NEW_SESSION_BUTTON }],
      [{ text: voiceEnabled ? VOICE_ON_BUTTON : VOICE_OFF_BUTTON }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

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
    private readonly ttsService: OpenaiTtsService,
    private readonly chatSettingsRepository: TelegramChatSettingsRepository,
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
    voiceModeEnabled?: boolean;
  }): Promise<void> {
    await this.sendChunkedText(params.botToken, params.chatId, params.text, {
      messageThreadId: params.messageThreadId,
      replyToMessageId: params.replyToMessageId,
      voiceModeEnabled: params.voiceModeEnabled ?? false,
    });
  }

  async emitRunResponse(
    triggerName: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    await this.emitForRun(triggerName, sessionKey, message, true);
  }

  async emitRunError(
    triggerName: string,
    sessionKey: string,
    message: string,
  ): Promise<void> {
    // Errors are always text — never spoken.
    await this.emitForRun(triggerName, sessionKey, message, false);
  }

  private async emitForRun(
    triggerName: string,
    sessionKey: string,
    message: string,
    allowVoice: boolean,
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

    const voiceEnabled =
      await this.chatSettingsRepository.isVoiceEnabled(sessionKey);
    const messageThreadId = session.messageThreadId ?? undefined;

    if (allowVoice && voiceEnabled) {
      await this.trySendVoiceNote(
        trigger.bot_token,
        session.chatId,
        message,
        messageThreadId,
      );
    }

    // Always send the text — primary in text mode, the safety net in voice mode.
    await this.sendChunkedText(trigger.bot_token, session.chatId, message, {
      messageThreadId,
      voiceModeEnabled: voiceEnabled,
    });
  }

  /** Synthesize and send a voice note; on failure log and fall back to text only. */
  private async trySendVoiceNote(
    botToken: string,
    chatId: string,
    message: string,
    messageThreadId: number | undefined,
  ): Promise<void> {
    if (!this.ttsService.isAvailable()) return;
    try {
      const audio = await this.ttsService.synthesize(message);
      await this.sendVoiceNote({ botToken, chatId, audio, messageThreadId });
    } catch (error) {
      this.logger.warn(
        'Failed to send Telegram voice note; sending text only',
        {
          error: error as Error,
        },
      );
    }
  }

  private async sendVoiceNote(params: {
    botToken: string;
    chatId: string;
    audio: Buffer;
    messageThreadId?: number;
  }): Promise<void> {
    const boundary = `----AgentQueueBoundary${Date.now()}`;
    const parts: Buffer[] = [
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${params.chatId}\r\n`,
      ),
    ];

    if (params.messageThreadId !== undefined) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="message_thread_id"\r\n\r\n${params.messageThreadId}\r\n`,
        ),
      );
    }

    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
      ),
      params.audio,
      Buffer.from('\r\n'),
      Buffer.from(`--${boundary}--\r\n`),
    );

    const response = await fetch(
      `${TELEGRAM_API_BASE_URL}/bot${params.botToken}/sendVoice`,
      {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: Buffer.concat(parts),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Telegram API sendVoice failed (${response.status}): ${errorText}`,
      );
    }
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
      voiceModeEnabled: boolean;
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
        ...(isLast
          ? { reply_markup: buildKeyboard(options.voiceModeEnabled) }
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
