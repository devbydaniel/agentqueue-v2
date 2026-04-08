/**
 * Event types that are meaningful for logging and persistence.
 * Noisy streaming events (message_start, message_update, etc.) are excluded.
 *
 * Shared by LoggerCallbackHandler and RunEventCallbackHandler.
 */
export const FILTERED_EVENT_TYPES = new Set([
  'agent_start',
  'agent_end',
  'turn_start',
  'turn_end',
  'message_end',
  'tool_execution_start',
  'tool_execution_end',
  'compaction_start',
  'compaction_end',
  'auto_retry_start',
  'auto_retry_end',
]);
