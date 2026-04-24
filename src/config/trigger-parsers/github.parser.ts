import type { Logger } from '@nestjs/common';
import type {
  GithubTrigger,
  WebhookFilter,
} from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const REQUIRED = ['name', 'cwd', 'prompt'] as const;

const validateFilter = (
  triggerName: string,
  filter: WebhookFilter,
  logger: Logger,
): boolean => {
  if (!filter.field || typeof filter.field !== 'string') {
    logger.warn(`GitHub trigger "${triggerName}" has a filter missing "field"`);
    return false;
  }
  if (filter.pattern === undefined) return true;
  try {
    // eslint-disable-next-line security/detect-non-literal-regexp -- pattern is from admin trigger config, not user input
    new RegExp(filter.pattern);
    return true;
  } catch {
    logger.warn(
      `GitHub trigger "${triggerName}" filter on "${filter.field}" has invalid regex: ${filter.pattern}`,
    );
    return false;
  }
};

const validateFilters = (
  triggerName: string,
  filters: unknown,
  logger: Logger,
): boolean => {
  if (filters === undefined) return true;
  if (!Array.isArray(filters)) {
    logger.warn(`GitHub trigger "${triggerName}" filters must be an array`);
    return false;
  }
  return (filters as WebhookFilter[]).every((f) =>
    validateFilter(triggerName, f, logger),
  );
};

const hasValidEvents = (
  events: unknown,
  triggerName: string,
  logger: Logger,
): boolean => {
  if (Array.isArray(events) && events.length > 0) return true;
  logger.warn(`GitHub trigger "${triggerName}" missing or empty events array`);
  return false;
};

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'GitHub trigger')) {
    return false;
  }
  const name = trigger['name'] as string;
  if (!validateCwd(trigger['cwd'] as string, name, 'github', logger)) {
    return false;
  }
  if (!hasValidEvents(trigger['events'], name, logger)) return false;
  return validateFilters(name, trigger['filters'], logger);
};

const mapEntry = (entry: Record<string, unknown>): GithubTrigger => ({
  name: entry['name'] as string,
  type: 'github',
  events: entry['events'] as string[],
  cwd: normalizeCwd(entry['cwd'] as string, 'github trigger cwd'),
  prompt: entry['prompt'] as string,
  ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
  ...(entry['filters'] ? { filters: entry['filters'] as WebhookFilter[] } : {}),
  ...(entry['before'] ? { before: entry['before'] as string } : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
});

export const parseGithubTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): GithubTrigger[] =>
  raw
    .filter((t) => t['type'] === 'github')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
