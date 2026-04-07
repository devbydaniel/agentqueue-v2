import { Injectable, Logger } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

/**
 * Tracks in-flight pi `AgentSession` instances by external session key
 * (e.g. Linear `agentSessionId`) so they can be aborted on demand.
 *
 * This is intentionally an in-memory service (not a repository): an
 * `AgentSession` is bound to the running process and cannot be persisted.
 */
@Injectable()
export class ActiveSessionTrackerService {
  private readonly logger = new Logger(ActiveSessionTrackerService.name);
  private readonly activeSessions = new Map<string, AgentSession>();

  track(sessionKey: string, session: AgentSession): void {
    this.activeSessions.set(sessionKey, session);
  }

  untrack(sessionKey: string): void {
    this.activeSessions.delete(sessionKey);
  }

  /**
   * Abort an in-flight session by its external key.
   * Returns true if a session was found and aborted, false otherwise.
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
