import type { Logger } from '@nestjs/common';
import {
  interpolateEnvVars,
  type SlackTrigger,
} from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const REQUIRED = [
  'name',
  'bot_name',
  'bot_token',
  'signing_secret',
  'cwd',
] as const;

const hasField = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

const stringOrNumberField = (value: unknown): string | undefined => {
  if (typeof value === 'string' || typeof value === 'number') {
    return value ? String(value) : undefined;
  }
  return undefined;
};

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'Slack trigger')) {
    return false;
  }
  if (!hasField(trigger['user_id']) && !hasField(trigger['channel_id'])) {
    logger.warn(
      `Slack trigger "${trigger['name'] as string}" requires at least one of user_id or channel_id`,
    );
    return false;
  }
  return validateCwd(
    trigger['cwd'] as string,
    trigger['name'] as string,
    'slack',
    logger,
  );
};

const mapEntry = (entry: Record<string, unknown>): SlackTrigger => {
  const userId = stringOrNumberField(entry['user_id']);
  const channelId = stringOrNumberField(entry['channel_id']);
  return {
    name: entry['name'] as string,
    type: 'slack',
    bot_name: entry['bot_name'] as string,
    bot_token: interpolateEnvVars(entry['bot_token'] as string),
    signing_secret: interpolateEnvVars(entry['signing_secret'] as string),
    cwd: normalizeCwd(entry['cwd'] as string, 'slack trigger cwd'),
    ...(userId ? { user_id: userId } : {}),
    ...(channelId ? { channel_id: channelId } : {}),
    ...(entry['append_system_prompt']
      ? { append_system_prompt: entry['append_system_prompt'] as string }
      : {}),
    ...(entry['timeout_ms']
      ? { timeout_ms: entry['timeout_ms'] as number }
      : {}),
  };
};

export const parseSlackTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): SlackTrigger[] =>
  raw
    .filter((t) => t['type'] === 'slack')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
