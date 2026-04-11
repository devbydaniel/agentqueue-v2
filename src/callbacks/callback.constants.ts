/**
 * SDK message types that are too noisy to persist in run_events.
 * Used by RunEventCallbackHandler to decide what NOT to store.
 *
 * An exclusion set is safer than an inclusion set: new SDK message types
 * are persisted by default rather than silently dropped.
 */
export const SKIPPED_MESSAGE_TYPES = new Set([
  'stream_event',
  'tool_progress',
  'auth_status',
  'rate_limit_event',
  'prompt_suggestion',
  'tool_use_summary',
]);

/**
 * System subtypes worth persisting. Everything else (hooks, tasks,
 * session state, local commands, etc.) is internal plumbing.
 */
export const PERSISTED_SYSTEM_SUBTYPES = new Set([
  'init',
  'status',
  'api_retry',
  'compact_boundary',
]);
