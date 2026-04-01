export interface CronTrigger {
  name: string;
  schedule: string;
  target: string;
  prompt: string;
  agent?: string;
  before?: string;
}

export interface LinearTrigger {
  name: string;
  type: 'linear';
  signing_secret: string;
  api_key: string;
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
