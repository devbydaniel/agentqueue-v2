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

export interface TriggersFile {
  triggers: (CronTrigger | LinearTrigger)[];
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

/**
 * Interpolate `{{key}}` patterns in a template string with values from a variable bag.
 * Unknown keys are left as-is.
 */
export function interpolateTemplate(
  template: string,
  vars: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    // eslint-disable-next-line security/detect-object-injection -- key comes from our own {{key}} pattern, not user input
    return vars[key] ?? _match;
  });
}
