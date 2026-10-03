import type { Logger } from '@nestjs/common';
import {
  interpolateEnvVars,
  type MatrixTrigger,
} from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const REQUIRED = [
  'name',
  'bot_name',
  'homeserver_url',
  'access_token',
  'user_id',
  'cwd',
] as const;

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'Matrix trigger')) {
    return false;
  }
  return validateCwd(
    trigger['cwd'] as string,
    trigger['name'] as string,
    'matrix',
    logger,
  );
};

const trimTrailingSlashes = (url: string): string => {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
};

const mapEntry = (entry: Record<string, unknown>): MatrixTrigger => ({
  name: entry['name'] as string,
  type: 'matrix',
  bot_name: entry['bot_name'] as string,
  homeserver_url: trimTrailingSlashes(entry['homeserver_url'] as string),
  access_token: interpolateEnvVars(entry['access_token'] as string),
  user_id: entry['user_id'] as string,
  cwd: normalizeCwd(entry['cwd'] as string, 'matrix trigger cwd'),
  ...(entry['room_id'] ? { room_id: entry['room_id'] as string } : {}),
  ...(entry['agent'] ? { agent: entry['agent'] as string } : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
});

export const parseMatrixTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): MatrixTrigger[] =>
  raw
    .filter((t) => t['type'] === 'matrix')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
