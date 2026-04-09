export interface CronTrigger {
  name: string;
  schedule: string;
  cwd: string;
  prompt: string;
  agent?: string;
  before?: string;
  prepend_system_prompt?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export interface LinearTrigger {
  name: string;
  type: 'linear';
  cwd: string;
  signing_secret: string;
  api_key: string;
  prepend_system_prompt?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export interface TelegramTrigger {
  name: string;
  type: 'telegram';
  bot_name: string;
  bot_token: string;
  webhook_secret: string;
  user_id: string;
  cwd: string;
  chat_id?: string;
  prepend_system_prompt?: string;
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
  prepend_system_prompt?: string;
  append_system_prompt?: string;
  timeout_ms?: number;
}

export interface TriggersFile {
  triggers: (CronTrigger | LinearTrigger | GithubTrigger | TelegramTrigger)[];
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
