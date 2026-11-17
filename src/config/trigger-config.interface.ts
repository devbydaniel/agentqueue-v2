export interface CronTrigger {
  name: string;
  schedule: string;
  cwd: string;
  prompt: string;
  before?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

export type LinearEventType = 'assigned' | 'mentioned';

export interface LinearTrigger {
  name: string;
  type: 'linear';
  on?: LinearEventType;
  cwd: string;
  signing_secret: string;
  /** Static Linear API key. Set either this or client_id + client_secret. */
  api_key?: string;
  /**
   * Linear OAuth app credentials. agentqueue requests client-credentials
   * tokens (app actor, 30 days) itself and renews them before they expire.
   */
  client_id?: string;
  client_secret?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

export interface TelegramTrigger {
  name: string;
  type: 'telegram';
  bot_name: string;
  bot_token: string;
  user_id: string;
  cwd: string;
  chat_id?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

export interface SlackTrigger {
  name: string;
  type: 'slack';
  bot_name: string;
  bot_token: string;
  signing_secret: string;
  cwd: string;
  /**
   * At least one of user_id or channel_id is required.
   * - user_id gates 1:1 assistant-pane conversations (Slack user ID, e.g. "U01234567").
   * - channel_id gates channel mentions or a specific DM channel (C.../D.../G... prefix).
   */
  user_id?: string;
  channel_id?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

export interface MatrixTrigger {
  name: string;
  type: 'matrix';
  bot_name: string;
  /** Client-server API base URL, e.g. the in-cluster `http://synapse.matrix.svc:8008`. */
  homeserver_url: string;
  access_token: string;
  /** Full Matrix ID allowed to talk to the bot, e.g. `@daniel:example.org`. */
  user_id: string;
  cwd: string;
  room_id?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Room in which the bot answers MatrixRTC (Element Call) calls from `user_id`. */
  call_room_id?: string;
  /**
   * LiveKit SFU URL as advertised to clients (`wss://…`); sent to the JWT
   * service and written into the bot's call membership. Set with call_room_id.
   */
  livekit_url?: string;
  /** SFU URL the bot itself connects to (e.g. in-cluster `ws://…`); defaults to livekit_url. */
  livekit_internal_url?: string;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

export interface WebhookFilter {
  field: string;
  equals?: string;
  contains?: string;
  in?: string[];
  pattern?: string;
}

export interface GithubTrigger {
  name: string;
  type: 'github';
  events: string[];
  cwd: string;
  prompt: string;
  filters?: WebhookFilter[];
  before?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
  /** Queue defined under top-level `queues`; default: the `runs` queue. */
  queue?: string;
  /** When true, the trigger is not registered. */
  paused?: boolean;
}

/** A named run queue with its own worker, from top-level `queues`. */
export interface QueueConfig {
  name: string;
  concurrency: number;
}

export interface TriggersFile {
  queues?: Record<string, { concurrency: number }>;
  triggers: (
    | CronTrigger
    | LinearTrigger
    | GithubTrigger
    | TelegramTrigger
    | SlackTrigger
    | MatrixTrigger
  )[];
}

/**
 * Interpolate `${VAR}` patterns in a string with values from `process.env`.
 * Returns the original string if no pattern is found or the env var is not set.
 */
export function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    // eslint-disable-next-line security/detect-object-injection -- varName comes from our own ${VAR} pattern, not user input
    return process.env[varName] ?? _match;
  });
}

// Re-export from common utils for backward compatibility
export { interpolateTemplate } from '../common/utils/interpolate-template.js';
