import { Injectable, Logger } from '@nestjs/common';

/**
 * Tracks in-flight AbortControllers by external key (e.g. Linear
 * `agentSessionId` or `runId`) so running sessions can be cancelled on demand.
 *
 * Supports dual-indexing: a single controller can be tracked under both a
 * `runId` and an `externalSessionId`. Both keys point at the same reference.
 *
 * This is intentionally an in-memory service (not a repository): an
 * AbortController is bound to the running process and cannot be persisted.
 */
@Injectable()
export class ActiveSessionTrackerService {
  private readonly logger = new Logger(ActiveSessionTrackerService.name);
  private readonly activeControllers = new Map<string, AbortController>();

  /**
   * Track an AbortController under one or more keys.
   * Pass `runId` to enable abort-by-runId from the dashboard.
   * Pass `externalSessionId` to enable abort-by-externalSessionId from webhook stop signals.
   */
  track(
    externalSessionId: string,
    controller: AbortController,
    runId?: string,
  ): void {
    this.activeControllers.set(externalSessionId, controller);
    if (runId) {
      this.activeControllers.set(runId, controller);
    }
  }

  /**
   * Remove a controller from all tracked keys.
   * Pass `runId` to also remove the runId-indexed entry.
   */
  untrack(externalSessionId: string, runId?: string): void {
    this.activeControllers.delete(externalSessionId);
    if (runId) {
      this.activeControllers.delete(runId);
    }
  }

  /**
   * Abort an in-flight session by any tracked key (runId or externalSessionId).
   * Returns true if a controller was found and aborted, false otherwise.
   */
  abort(key: string): boolean {
    const controller = this.activeControllers.get(key);
    if (!controller) {
      this.logger.warn(`No active session found for key: ${key}`);
      return false;
    }
    this.logger.log(`Aborting session: ${key}`);
    controller.abort();
    return true;
  }

  /**
   * Abort all currently tracked sessions. Used during graceful shutdown.
   * Deduplicates controllers that are tracked under multiple keys.
   */
  abortAll(): number {
    const uniqueControllers = new Set(this.activeControllers.values());
    this.logger.log(`Aborting all ${uniqueControllers.size} active session(s)`);
    for (const controller of uniqueControllers) {
      try {
        controller.abort();
      } catch (error) {
        this.logger.error('Failed to abort session during shutdown', {
          error: error as Error,
        });
      }
    }
    this.activeControllers.clear();
    return uniqueControllers.size;
  }
}
