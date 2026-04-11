import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Interface for agent run event handlers that consume SDK messages.
 *
 * Each handler receives every SDKMessage from the session's async generator
 * and decides internally which message types to act on.
 */
export interface RunEventHandler {
  /** Unique name for this handler (used in logs). */
  readonly name: string;

  /** Called for every SDK message during the run. */
  onMessage(message: SDKMessage): void | Promise<void>;

  /**
   * Called after the SDK async generator completes or throws.
   * `result` is undefined when the session errored before yielding a result message.
   * Use for cleanup (closing spans, flushing pending API calls).
   */
  onComplete?(result: SDKResultMessage | undefined): void | Promise<void>;
}
