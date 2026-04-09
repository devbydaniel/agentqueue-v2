import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PgPool } from '../database/database.tokens.js';
import { PG_POOL } from '../database/database.tokens.js';
import { mapRow } from '../database/query-helpers.js';
import type { ExternalSessionRow } from '../database/external-sessions.schema.js';

export type ExternalSessionProvider = 'linear' | 'telegram';

export interface UpsertExternalSessionParams {
  provider: ExternalSessionProvider;
  sessionKey: string;
  filePath: string | null;
  botName?: string;
  chatId?: string;
  messageThreadId?: number;
  lastActivityAt?: Date;
}

@Injectable()
export class ExternalSessionRepository {
  private readonly logger = new Logger(ExternalSessionRepository.name);

  constructor(@Inject(PG_POOL) private readonly pool: PgPool) {}

  async findBySessionKey(
    sessionKey: string,
  ): Promise<ExternalSessionRow | null> {
    const result = await this.pool.query(
      'SELECT * FROM external_sessions WHERE session_key = $1',
      [sessionKey],
    );

    return result.rows[0]
      ? mapRow<ExternalSessionRow>(result.rows[0] as Record<string, unknown>)
      : null;
  }

  async findFilePath(sessionKey: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT file_path FROM external_sessions WHERE session_key = $1',
      [sessionKey],
    );

    const row = result.rows[0] as { file_path?: string | null } | undefined;
    return row?.file_path ?? null;
  }

  async upsertSession(params: UpsertExternalSessionParams): Promise<void> {
    const now = new Date();
    await this.pool.query(
      `INSERT INTO external_sessions (
        provider,
        session_key,
        file_path,
        bot_name,
        chat_id,
        message_thread_id,
        last_activity_at,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (session_key) DO UPDATE SET
        provider = EXCLUDED.provider,
        file_path = EXCLUDED.file_path,
        bot_name = COALESCE(EXCLUDED.bot_name, external_sessions.bot_name),
        chat_id = COALESCE(EXCLUDED.chat_id, external_sessions.chat_id),
        message_thread_id = COALESCE(
          EXCLUDED.message_thread_id,
          external_sessions.message_thread_id
        ),
        last_activity_at = EXCLUDED.last_activity_at,
        updated_at = EXCLUDED.updated_at`,
      [
        params.provider,
        params.sessionKey,
        params.filePath,
        params.botName ?? null,
        params.chatId ?? null,
        params.messageThreadId ?? null,
        params.lastActivityAt ?? now,
        now,
      ],
    );

    this.logger.debug('Upserted external session mapping', {
      provider: params.provider,
      sessionKey: params.sessionKey,
      filePath: params.filePath,
    });
  }

  async deleteBySessionKey(sessionKey: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM external_sessions WHERE session_key = $1',
      [sessionKey],
    );
  }
}
