/* eslint-disable @typescript-eslint/require-await -- in-memory implementation; bodies will use await when backed by a real database */
import { Injectable, Logger } from '@nestjs/common';

/**
 * Maps external Linear session keys (`agentSessionId`) to the local pi
 * session file path so a follow-up message in the same Linear session can
 * resume the previous pi session.
 *
 * Currently in-memory; the API is async so the eventual database-backed
 * implementation can drop in without changing callers.
 */
@Injectable()
export class LinearSessionRepository {
  private readonly logger = new Logger(LinearSessionRepository.name);
  private readonly filePathsBySessionKey = new Map<string, string>();

  async findFilePath(sessionKey: string): Promise<string | null> {
    return this.filePathsBySessionKey.get(sessionKey) ?? null;
  }

  async saveFilePath(sessionKey: string, filePath: string): Promise<void> {
    this.filePathsBySessionKey.set(sessionKey, filePath);
    this.logger.debug('Stored session file mapping', { sessionKey, filePath });
  }
}
