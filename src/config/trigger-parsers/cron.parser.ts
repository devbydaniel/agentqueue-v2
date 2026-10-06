import type { Logger } from '@nestjs/common';
import type { CronTrigger } from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const REQUIRED = ['name', 'schedule', 'cwd', 'prompt'] as const;

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'Cron trigger')) {
    return false;
  }
  return validateCwd(
    trigger['cwd'] as string,
    trigger['name'] as string,
    'cron',
    logger,
  );
};

const mapEntry = (entry: Record<string, unknown>): CronTrigger => ({
  name: entry['name'] as string,
  schedule: entry['schedule'] as string,
  cwd: normalizeCwd(entry['cwd'] as string, 'cron trigger cwd'),
  prompt: entry['prompt'] as string,
  ...(entry['before'] ? { before: entry['before'] as string } : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
});

export const parseCronTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): CronTrigger[] =>
  raw
    .filter((t) => !t['type'] || t['type'] === 'cron')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
