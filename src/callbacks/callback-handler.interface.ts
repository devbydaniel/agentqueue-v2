import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

/**
 * Interface for agent run callback handlers.
 *
 * Each handler receives every AgentSessionEvent and decides
 * internally which event types to act on.
 */
export interface CallbackHandler {
  /** Unique name for this handler (used in logs). */
  readonly name: string;

  /** Called for every session event. */
  onEvent(event: AgentSessionEvent): void | Promise<void>;
}
