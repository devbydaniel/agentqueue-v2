import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};

/** Session facts known once the pi session is created, before the prompt runs. */
export interface SessionStartInfo {
  sessionId: string;
  /** `provider/model-id`, or undefined if no model resolved */
  model: string | undefined;
  tools: string[];
}

/**
 * Interface for agent run event handlers that consume pi session events.
 *
 * Each handler receives every event from the session and decides internally
 * which event types to act on.
 */
export interface RunEventHandler {
  /** Unique name for this handler (used in logs). */
  readonly name: string;

  /** Called once after the session is created, before the prompt is sent. */
  onStart?(info: SessionStartInfo): void | Promise<void>;

  /** Called for every pi session event during the run, in emission order. */
  onEvent(event: AgentSessionEvent): void | Promise<void>;

  /**
   * Called after the session settles or throws.
   * Use for cleanup (flushing pending API calls).
   */
  onComplete?(): void | Promise<void>;
}
