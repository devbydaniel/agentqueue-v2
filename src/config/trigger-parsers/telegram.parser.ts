import type { Logger } from '@nestjs/common';
import {
  interpolateEnvVars,
  type TelegramTrigger,
} from '../trigger-config.interface.js';
import { normalizeCwd } from '../../common/utils/cwd-path.js';
import { hasRequiredFields, validateCwd } from './common.js';

const REQUIRED = ['name', 'bot_name', 'bot_token', 'user_id', 'cwd'] as const;

const validate = (
  trigger: Record<string, unknown>,
  logger: Logger,
): boolean => {
  if (!hasRequiredFields(trigger, REQUIRED, logger, 'Telegram trigger')) {
    return false;
  }
  return validateCwd(
    trigger['cwd'] as string,
    trigger['name'] as string,
    'telegram',
    logger,
  );
};

const mapEntry = (entry: Record<string, unknown>): TelegramTrigger => ({
  name: entry['name'] as string,
  type: 'telegram',
  bot_name: entry['bot_name'] as string,
  bot_token: interpolateEnvVars(entry['bot_token'] as string),
  user_id: String(entry['user_id']),
  cwd: normalizeCwd(entry['cwd'] as string, 'telegram trigger cwd'),
  ...((typeof entry['chat_id'] === 'string' ||
    typeof entry['chat_id'] === 'number') &&
  entry['chat_id']
    ? { chat_id: String(entry['chat_id']) }
    : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
});

export const parseTelegramTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): TelegramTrigger[] =>
  raw
    .filter((t) => t['type'] === 'telegram')
    .filter((t) => validate(t, logger))
    .map(mapEntry);
