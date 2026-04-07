export interface CronTrigger {
  name: string;
  schedule: string;
  target: string;
  prompt: string;
  agent?: string;
  before?: string;
  prepend_system_prompt?: string;
  append_system_prompt?: string;
}

export interface LinearTrigger {
  name: string;
  type: 'linear';
  target: string;
  signing_secret: string;
  api_key: string;
  prepend_system_prompt?: string;
  append_system_prompt?: string;
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
  target: string;
  prompt: string;
  filters?: WebhookFilter[];
  before?: string;
  prepend_system_prompt?: string;
  append_system_prompt?: string;
}

export interface TriggersFile {
  triggers: (CronTrigger | LinearTrigger | GithubTrigger)[];
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
