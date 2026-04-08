import { Logger } from '@nestjs/common';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { CallbackHandler } from '../callback-handler.interface.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';
import { FILTERED_EVENT_TYPES } from '../callback.constants.js';

/**
 * Callback handler that writes filtered session events to the run_events table.
 *
 * Instantiated per-run (not via DI) because it needs the runId of the
 * currently-running run. Created by RunProcessorService and passed as
 * an additional handler.
 */
export class RunEventCallbackHandler implements CallbackHandler {
  readonly name = 'run-event';
  private readonly logger = new Logger(RunEventCallbackHandler.name);

  constructor(
    private readonly runId: string,
    private readonly runEventRepository: RunEventRepository,
  ) {}

  onEvent(event: AgentSessionEvent): void {
    if (!FILTERED_EVENT_TYPES.has(event.type)) return;

    // Fire-and-forget write — don't block the session on DB writes.
    // Errors are logged but swallowed so a DB hiccup doesn't crash the run.
    const payload = this.extractPayload(event);
    this.runEventRepository
      .append(this.runId, event.type, payload)
      .catch((err) => {
        this.logger.error('Failed to persist run event', {
          runId: this.runId,
          eventType: event.type,
          error: err as Error,
        });
      });
  }

  private extractPayload(
    event: AgentSessionEvent,
  ): Record<string, unknown> | null {
    // Strip the `type` field — it's already stored in its own column.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { type, ...rest } = event as Record<string, unknown>;
    // Return null if there's nothing left beyond `type`
    return Object.keys(rest).length > 0 ? rest : null;
  }
}
