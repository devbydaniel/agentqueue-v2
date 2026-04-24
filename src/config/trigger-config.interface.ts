export interface CronTrigger {
  name: string;
  schedule: string;
  cwd: string;
  prompt: string;
  agent?: string;
  before?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export type LinearEventType = 'assigned' | 'mentioned';

export interface LinearTrigger {
  name: string;
  type: 'linear';
  on?: LinearEventType;
  cwd: string;
  signing_secret: string;
  api_key: string;
  agent?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export interface TelegramTrigger {
  name: string;
  type: 'telegram';
  bot_name: string;
  bot_token: string;
  user_id: string;
  cwd: string;
  chat_id?: string;
  agent?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
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
  agent?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
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
  agent?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export interface TriggersFile {
  triggers: (
    | CronTrigger
    | LinearTrigger
    | GithubTrigger
    | TelegramTrigger
    | SlackTrigger
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
