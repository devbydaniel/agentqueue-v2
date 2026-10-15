import { Logger } from '@nestjs/common';
import type { AgentSession } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};

type SteerTarget = Pick<
  AgentSession,
  'steer' | 'waitForIdle' | 'clearQueue' | 'prompt'
>;

/**
 * A live pi session that accepts messages while it runs. A steer is delivered
 * after the current tool calls, before the next model request.
 *
 * pi checks its queue only at turn boundaries, so a steer that lands after the
 * last check would sit in the queue of a session about to close. `settle()`
 * picks such leftovers up and runs another turn for them; once it returns, the
 * handle is closed and `steer()` reports false so the caller starts a new run.
 */
export class SteerableSession {
  private readonly logger = new Logger(SteerableSession.name);
  private closed = false;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly session: SteerTarget) {}

  get isClosed(): boolean {
    return this.closed;
  }

  /** Queue `text` into the running session. False if it no longer accepts input. */
  async steer(text: string): Promise<boolean> {
    if (this.closed) return false;
    const pending = this.session.steer(text);
    this.inflight.add(pending);
    try {
      await pending;
      return true;
    } catch (error) {
      this.logger.warn('Failed to steer session', { error: error as Error });
      return false;
    } finally {
      this.inflight.delete(pending);
    }
  }

  /**
   * Wait until pi is idle with nothing queued, running another turn for steers
   * that arrived after pi's last queue check. Closes the handle.
   */
  async settle(signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        await this.session.waitForIdle();
        await Promise.allSettled([...this.inflight]);
        if (signal.aborted) return;
        const { steering, followUp } = this.session.clearQueue();
        const leftover = [...steering, ...followUp];
        if (leftover.length === 0) {
          // A steer that started after allSettled has not queued yet; wait for it.
          if (this.inflight.size === 0) return;
          continue;
        }
        // Queued text is already expanded; don't expand templates twice.
        await this.session.prompt(leftover.join('\n\n'), {
          expandPromptTemplates: false,
        });
      }
    } finally {
      this.close();
    }
  }

  close(): void {
    this.closed = true;
  }
}
