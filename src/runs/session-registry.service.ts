import { Injectable, Logger } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

/**
 * Maps external session keys (e.g. Linear agentSessionId) to pi session
 * file paths for resumption, and tracks active sessions for cancellation.
 */
@Injectable()
export class SessionRegistryService {
  private readonly logger = new Logger(SessionRegistryService.name);
  private readonly sessionFiles = new Map<string, string>();
  private readonly activeSessions = new Map<string, AgentSession>();

  /**
   * Get the stored pi session file path for an external session key.
   */
  getSessionFile(sessionKey: string): string | undefined {
    return this.sessionFiles.get(sessionKey);
  }

  /**
   * Store the pi session file path for an external session key.
   */
  storeSessionFile(sessionKey: string, filePath: string): void {
    this.sessionFiles.set(sessionKey, filePath);
    this.logger.debug('Stored session file mapping', { sessionKey, filePath });
  }

  /**
   * Track an active (in-progress) session for later cancellation.
   */
  trackActive(sessionKey: string, session: AgentSession): void {
    this.activeSessions.set(sessionKey, session);
  }

  /**
   * Untrack an active session (call after run completes).
   */
  untrackActive(sessionKey: string): void {
    this.activeSessions.delete(sessionKey);
  }

  /**
   * Abort a tracked session by its external key.
   * Returns true if the session was found and aborted.
   */
  async abort(sessionKey: string): Promise<boolean> {
    const session = this.activeSessions.get(sessionKey);
    if (!session) {
      this.logger.warn(`No active session found for key: ${sessionKey}`);
      return false;
    }
    this.logger.log(`Aborting session: ${sessionKey}`);
    await session.abort();
    return true;
  }
}
