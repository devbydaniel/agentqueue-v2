import { Injectable, Logger } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';

/**
 * Tracks in-flight pi `AgentSession` instances by external key
 * (e.g. Linear `agentSessionId` or `runId`) so they can be aborted on demand.
 *
 * Supports dual-indexing: a single session can be tracked under both a
 * `runId` and a `sessionKey`. Both keys point at the same session reference.
 *
 * This is intentionally an in-memory service (not a repository): an
 * `AgentSession` is bound to the running process and cannot be persisted.
 */
@Injectable()
export class ActiveSessionTrackerService {
  private readonly logger = new Logger(ActiveSessionTrackerService.name);
  private readonly activeSessions = new Map<string, AgentSession>();

  /**
   * Track a session under one or more keys.
   * Pass `runId` to enable abort-by-runId from the dashboard.
   * Pass `sessionKey` to enable abort-by-sessionKey from Linear stop signals.
   */
  track(sessionKey: string, session: AgentSession, runId?: string): void {
    this.activeSessions.set(sessionKey, session);
    if (runId) {
      this.activeSessions.set(runId, session);
    }
  }

  /**
   * Remove a session from all tracked keys.
   * Pass `runId` to also remove the runId-indexed entry.
   */
  untrack(sessionKey: string, runId?: string): void {
    this.activeSessions.delete(sessionKey);
    if (runId) {
      this.activeSessions.delete(runId);
    }
  }

  /**
   * Abort an in-flight session by any tracked key (runId or sessionKey).
   * Returns true if a session was found and aborted, false otherwise.
   */
  async abort(key: string): Promise<boolean> {
    const session = this.activeSessions.get(key);
    if (!session) {
      this.logger.warn(`No active session found for key: ${key}`);
      return false;
    }
    this.logger.log(`Aborting session: ${key}`);
    await session.abort();
    return true;
  }

  /**
   * Abort all currently tracked sessions. Used during graceful shutdown.
   * Deduplicates sessions that are tracked under multiple keys.
   */
  async abortAll(): Promise<number> {
    const uniqueSessions = new Set(this.activeSessions.values());
    this.logger.log(`Aborting all ${uniqueSessions.size} active session(s)`);
    const abortPromises = [...uniqueSessions].map(async (session) => {
      try {
        await session.abort();
      } catch (error) {
        this.logger.error('Failed to abort session during shutdown', {
          error: error as Error,
        });
      }
    });
    await Promise.all(abortPromises);
    this.activeSessions.clear();
    return uniqueSessions.size;
  }
}
