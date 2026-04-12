import { Logger } from '@nestjs/common';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RunEventHandler } from '../run-event-handler.interface.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';
import {
  SKIPPED_MESSAGE_TYPES,
  PERSISTED_SYSTEM_SUBTYPES,
} from '../callback.constants.js';

/**
 * Callback handler that writes filtered SDK messages to the run_events table.
 *
 * Instantiated per-run (not via DI) because it needs the runId of the
 * currently-running run. Created by RunProcessorService and passed as
 * an additional handler.
 */
export class RunEventCallbackHandler implements RunEventHandler {
  readonly name = 'run-event';
  private readonly logger = new Logger(RunEventCallbackHandler.name);

  constructor(
    private readonly runId: string,
    private readonly runEventRepository: RunEventRepository,
  ) {}

  onMessage(message: SDKMessage): void {
    if (SKIPPED_MESSAGE_TYPES.has(message.type)) return;

    // For system messages, only persist meaningful subtypes
    if (message.type === 'system') {
      if (
        !('subtype' in message) ||
        !PERSISTED_SYSTEM_SUBTYPES.has(message.subtype)
      ) {
        return;
      }
    }

    const eventType = this.resolveEventType(message);
    const payload = this.extractPayload(message);

    // Fire-and-forget write — don't block the session on DB writes.
    // Errors are logged but swallowed so a DB hiccup doesn't crash the run.
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

  /**
   * For system messages, store `system:<subtype>` for queryability.
   * For everything else, store the message type directly.
   */
  private resolveEventType(message: SDKMessage): string {
    if (message.type === 'system' && 'subtype' in message) {
      return `system:${message.subtype}`;
    }
    return message.type;
  }

  private extractPayload(message: SDKMessage): Record<string, unknown> | null {
    const raw = message as Record<string, unknown>;
    // Strip fields that are either stored in their own column or add noise
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { type, uuid, session_id, ...rest } = raw;
    return Object.keys(rest).length > 0 ? rest : null;
  }
}
