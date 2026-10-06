import { Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import type {
  RunEventHandler,
  SessionStartInfo,
} from '../run-event-handler.interface.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';
import { SKIPPED_EVENT_TYPES } from '../callback.constants.js';

/**
 * Callback handler that writes filtered pi session events to the run_events
 * table.
 *
 * Event types stored:
 * - `session_start` — session id, model, tools
 * - `message:<role>` — each completed message (`message:assistant`,
 *   `message:toolResult`, `message:user`, …) except the system prompt,
 *   payload is the message
 * - everything not in SKIPPED_EVENT_TYPES under its pi event type
 *   (compaction, retries)
 *
 * Instantiated per-run (not via DI) because it needs the runId of the
 * currently-running run. Created by RunHandlerBuilder and passed as
 * an additional handler.
 */
export class RunEventCallbackHandler implements RunEventHandler {
  readonly name = 'run-event';
  private readonly logger = new Logger(RunEventCallbackHandler.name);

  constructor(
    private readonly runId: string,
    private readonly runEventRepository: RunEventRepository,
  ) {}

  onStart(info: SessionStartInfo): void {
    this.persist('session_start', { ...info });
  }

  onEvent(event: AgentSessionEvent): void {
    if (event.type === 'message_end') {
      // The system message restates the full system prompt on every run.
      if (event.message.role === 'system') return;
      this.persist(`message:${event.message.role}`, { ...event.message });
      return;
    }
    if (SKIPPED_EVENT_TYPES.has(event.type)) return;

    const { type, ...rest } = event;
    this.persist(type, Object.keys(rest).length > 0 ? rest : null);
  }

  /**
   * Fire-and-forget write — don't block the session on DB writes.
   * Errors are logged but swallowed so a DB hiccup doesn't crash the run.
   */
  private persist(
    eventType: string,
    payload: Record<string, unknown> | null,
  ): void {
    this.runEventRepository
      .append(this.runId, eventType, payload)
      .catch((err) => {
        this.logger.error('Failed to persist run event', {
          runId: this.runId,
          eventType,
          error: err as Error,
        });
      });
  }
}
