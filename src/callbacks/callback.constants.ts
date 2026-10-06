/**
 * pi session event types that are too noisy or redundant to persist in
 * run_events. Used by RunEventCallbackHandler to decide what NOT to store.
 *
 * Completed messages are persisted from `message_end`, so the streaming,
 * per-turn, and tool-execution events that restate them are skipped.
 *
 * An exclusion set is safer than an inclusion set: new pi event types are
 * persisted by default rather than silently dropped.
 */
export const SKIPPED_EVENT_TYPES = new Set([
  'agent_start',
  'agent_end',
  'agent_settled',
  'turn_start',
  'turn_end',
  'message_start',
  'message_update',
  'tool_execution_start',
  'tool_execution_update',
  'tool_execution_end',
  'bash_execution_update',
  'queue_update',
  'entry_appended',
  'session_info_changed',
  'thinking_level_changed',
]);
