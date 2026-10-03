import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { OpenaiTtsService } from '../telegram/openai-tts.service.js';
import { MatrixClient } from './matrix-client.js';
import {
  inThread,
  parseSessionKey,
  renderMessage,
  splitOversized,
} from './matrix-content.js';

// Typing notifications expire server-side; refresh well inside the timeout.
const TYPING_TIMEOUT_MS = 30_000;
const TYPING_REFRESH_MS = 20_000;

/** Room account data holding per-room connector settings (voice mode). */
export const SETTINGS_ACCOUNT_DATA_TYPE = 'de.danielbenner.agentqueue.settings';

interface RoomSettings {
  voice_mode?: boolean;
}

export interface MatrixTarget {
  botName: string;
  roomId: string;
  threadRootId: string | undefined;
}

/**
 * Registry of per-bot Matrix clients plus the outbound operations shared by
 * the ingest path and the streaming reply handler.
 */
@Injectable()
export class MatrixService implements OnModuleDestroy {
  private readonly logger = new Logger(MatrixService.name);
  private readonly clients = new Map<string, MatrixClient>();
  private readonly userIds = new Map<string, string>();
  private readonly typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly ttsService: OpenaiTtsService,
  ) {}

  onModuleDestroy(): void {
    for (const timer of this.typingTimers.values()) clearInterval(timer);
    this.typingTimers.clear();
  }

  getClient(botName: string): MatrixClient | undefined {
    const existing = this.clients.get(botName);
    if (existing) return existing;
    const trigger = this.triggerConfigService
      .getMatrixTriggersForBot(botName)
      .at(0);
    if (!trigger) return undefined;
    const client = new MatrixClient(
      trigger.homeserver_url,
      trigger.access_token,
    );
    this.clients.set(botName, client);
    return client;
  }

  registerUserId(botName: string, userId: string): void {
    this.userIds.set(botName, userId);
  }

  getUserId(botName: string): string | undefined {
    return this.userIds.get(botName);
  }

  startTyping(sessionKey: string): void {
    this.stopTypingTimer(sessionKey);
    const fire = (): void => void this.sendTyping(sessionKey, true);
    fire();
    this.typingTimers.set(sessionKey, setInterval(fire, TYPING_REFRESH_MS));
  }

  stopTyping(sessionKey: string): void {
    this.stopTypingTimer(sessionKey);
    // Typing is room-wide; keep it on while another session in the room runs.
    const roomPrefix = sessionKey.slice(0, sessionKey.lastIndexOf(':') + 1);
    const roomStillBusy = [...this.typingTimers.keys()].some((key) =>
      key.startsWith(roomPrefix),
    );
    if (!roomStillBusy) void this.sendTyping(sessionKey, false);
  }

  async isVoiceEnabled(botName: string, roomId: string): Promise<boolean> {
    const client = this.getClient(botName);
    const userId = this.getUserId(botName);
    if (!client || !userId) return false;
    try {
      const settings = await client.getRoomAccountData<RoomSettings>(
        userId,
        roomId,
        SETTINGS_ACCOUNT_DATA_TYPE,
      );
      return settings?.voice_mode === true;
    } catch (error) {
      this.logger.warn('Failed to read Matrix room settings', {
        error: error as Error,
        roomId,
      });
      return false;
    }
  }

  async setVoiceEnabled(
    botName: string,
    roomId: string,
    enabled: boolean,
  ): Promise<void> {
    const client = this.requireClient(botName);
    const userId = this.getUserId(botName);
    if (!userId) throw new Error(`Matrix bot "${botName}" is not connected`);
    await client.setRoomAccountData(
      userId,
      roomId,
      SETTINGS_ACCOUNT_DATA_TYPE,
      {
        voice_mode: enabled,
      },
    );
  }

  /** Send markdown text, split across several messages if it is oversized. */
  async sendText(target: MatrixTarget, text: string): Promise<void> {
    const client = this.requireClient(target.botName);
    let remaining = text;
    while (remaining) {
      const [head, rest] = splitOversized(remaining);
      await client.sendMessage(
        target.roomId,
        inThread(renderMessage(head), target.threadRootId),
      );
      remaining = rest;
    }
  }

  /** Low-key status line (transcript echoes, confirmations); never notifies. */
  async sendNotice(target: MatrixTarget, text: string): Promise<void> {
    const client = this.requireClient(target.botName);
    await client.sendMessage(
      target.roomId,
      inThread({ msgtype: 'm.notice', body: text }, target.threadRootId),
    );
  }

  /** Speak `text` as a voice message. Logs and gives up on failure. */
  async sendVoiceNote(target: MatrixTarget, text: string): Promise<void> {
    if (!this.ttsService.isAvailable()) return;
    try {
      const client = this.requireClient(target.botName);
      const audio = await this.ttsService.synthesize(text);
      const url = await client.uploadMedia(audio, 'audio/ogg', 'voice.ogg');
      await client.sendMessage(
        target.roomId,
        inThread(
          {
            msgtype: 'm.audio',
            body: 'Voice message',
            url,
            info: { mimetype: 'audio/ogg', size: audio.length },
            'org.matrix.msc1767.audio': {},
            'org.matrix.msc3245.voice': {},
          },
          target.threadRootId,
        ),
      );
    } catch (error) {
      this.logger.warn('Failed to send Matrix voice message', {
        error: error as Error,
      });
    }
  }

  private requireClient(botName: string): MatrixClient {
    const client = this.getClient(botName);
    if (!client) throw new Error(`No Matrix trigger for bot "${botName}"`);
    return client;
  }

  private stopTypingTimer(sessionKey: string): void {
    const timer = this.typingTimers.get(sessionKey);
    if (timer) clearInterval(timer);
    this.typingTimers.delete(sessionKey);
  }

  private async sendTyping(sessionKey: string, typing: boolean): Promise<void> {
    const parsed = parseSessionKey(sessionKey);
    const client = parsed && this.getClient(parsed.botName);
    const userId = parsed && this.getUserId(parsed.botName);
    if (!parsed || !client || !userId) return;
    try {
      await client.setTyping(parsed.roomId, userId, typing, TYPING_TIMEOUT_MS);
    } catch (error) {
      this.logger.debug('Matrix typing notification failed', {
        error: error as Error,
        sessionKey,
      });
    }
  }
}
