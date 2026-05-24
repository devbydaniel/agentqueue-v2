import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';
import { mapRow } from '../database/query-helpers.js';
import type { TelegramChatSettingsRow } from '../database/telegram-chat-settings.schema.js';

/**
 * Per-chat Telegram preferences keyed by the same `session_key` the ingest path
 * builds (`telegram:botName:chatId:threadId`). Stored separately from
 * `external_sessions` so the voice-mode toggle survives `/reset` and idle expiry.
 */
@Injectable()
export class TelegramChatSettingsRepository {
  private readonly logger = new Logger(TelegramChatSettingsRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async isVoiceEnabled(sessionKey: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT voice_mode_enabled FROM telegram_chat_settings WHERE session_key = $1',
      [sessionKey],
    );

    const row = result.rows[0] as { voice_mode_enabled?: boolean } | undefined;
    return row?.voice_mode_enabled ?? false;
  }

  async findBySessionKey(
    sessionKey: string,
  ): Promise<TelegramChatSettingsRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM telegram_chat_settings WHERE session_key = $1',
      [sessionKey],
    );

    return result.rows[0]
      ? mapRow<TelegramChatSettingsRow>(
          result.rows[0] as Record<string, unknown>,
        )
      : null;
  }

  async setVoiceEnabled(sessionKey: string, enabled: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO telegram_chat_settings (
        session_key,
        voice_mode_enabled,
        updated_at
      ) VALUES ($1,$2,$3)
      ON CONFLICT (session_key) DO UPDATE SET
        voice_mode_enabled = EXCLUDED.voice_mode_enabled,
        updated_at = EXCLUDED.updated_at`,
      [sessionKey, enabled, new Date()],
    );

    this.logger.debug('Updated Telegram chat voice mode', {
      sessionKey,
      enabled,
    });
  }
}
