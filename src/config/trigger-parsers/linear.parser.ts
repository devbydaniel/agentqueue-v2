import type { Logger } from '@nestjs/common';
import {
  interpolateEnvVars,
  type LinearEventType,
  type LinearTrigger,
} from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const VALID_LINEAR_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'assigned',
  'mentioned',
]);

const REQUIRED = ['name', 'cwd', 'signing_secret', 'api_key'] as const;

const hasValidOn = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  const on = trigger['on'];
  if (on === undefined) return true;
  if (VALID_LINEAR_EVENT_TYPES.has(on as string)) return true;
  logger.warn(
    `Linear trigger "${trigger['name'] as string}" has invalid "on" value: "${on as string}". Must be "assigned" or "mentioned".`,
  );
  return false;
};

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'Linear trigger')) {
    return false;
  }
  if (!hasValidOn(trigger, logger)) return false;
  return validateCwd(
    trigger['cwd'] as string,
    trigger['name'] as string,
    'linear',
    logger,
  );
};

const mapEntry = (entry: Record<string, unknown>): LinearTrigger => ({
  name: entry['name'] as string,
  type: 'linear',
  ...(entry['on'] ? { on: entry['on'] as LinearEventType } : {}),
  cwd: normalizeCwd(entry['cwd'] as string, 'linear trigger cwd'),
  signing_secret: interpolateEnvVars(entry['signing_secret'] as string),
  api_key: interpolateEnvVars(entry['api_key'] as string),
  ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
});

// Multiple triggers may share a name when each targets a different `on` event.
// Reject groups that are inconsistent (different secrets, missing `on`, or
// duplicate `on`) — those are user-authored config mistakes.
const inconsistentGroupReason = (
  group: LinearTrigger[],
): string | undefined => {
  const first = group[0];
  if (
    group.some(
      (t) =>
        t.signing_secret !== first.signing_secret ||
        t.api_key !== first.api_key,
    )
  ) {
    return 'inconsistent signing_secret/api_key';
  }
  if (group.some((t) => t.on === undefined)) {
    return 'trigger without "on" cannot coexist with siblings';
  }
  if (new Set(group.map((t) => t.on)).size !== group.length) {
    return 'duplicate "on" values';
  }
  return undefined;
};

const crossValidate = (
  triggers: LinearTrigger[],
  logger: Logger,
): LinearTrigger[] => {
  const byName = new Map<string, LinearTrigger[]>();
  for (const t of triggers) {
    const group = byName.get(t.name) ?? [];
    group.push(t);
    byName.set(t.name, group);
  }

  const valid: LinearTrigger[] = [];
  for (const [name, group] of byName) {
    if (group.length === 1) {
      valid.push(group[0]);
      continue;
    }
    const reason = inconsistentGroupReason(group);
    if (reason) {
      logger.error(
        `Linear triggers sharing name "${name}": ${reason} — discarding group`,
      );
    } else {
      valid.push(...group);
    }
  }
  return valid;
};

export const parseLinearTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): LinearTrigger[] => {
  const entries = raw
    .filter((t) => t['type'] === 'linear')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
  return crossValidate(entries, logger);
};

export { VALID_LINEAR_EVENT_TYPES };
