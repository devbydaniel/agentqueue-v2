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

const isWebsocketUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^wss?:\/\/[^/\s]+/.test(value);

const callConfigProblem = (
  roomId: unknown,
  url: unknown,
  internalUrl: unknown,
): string | undefined => {
  if (typeof roomId !== 'string' || !roomId.startsWith('!')) {
    return 'call_room_id must be a room ID (!…)';
  }
  if (!isWebsocketUrl(url)) return 'livekit_url must be a ws:// or wss:// URL';
  if (!isWebsocketUrl(internalUrl)) {
    return 'livekit_internal_url must be a ws:// or wss:// URL';
  }
  return undefined;
};

/**
 * The call keys, if they make a usable call config. A broken call config
 * only disables calls; the trigger still serves text.
 */
const parseCallConfig = (
  entry: Record<string, unknown>,
  logger: Logger,
): Pick<
  MatrixTrigger,
  'call_room_id' | 'livekit_url' | 'livekit_internal_url'
> => {
  const roomId = entry['call_room_id'];
  if (roomId === undefined || roomId === null || roomId === '') return {};
  const url = entry['livekit_url'];
  const internalUrl = entry['livekit_internal_url'] ?? url;
  const name = entry['name'] as string;
  const problem = callConfigProblem(roomId, url, internalUrl);
  if (problem) {
    logger.warn(`Matrix trigger "${name}": ${problem}; calls disabled`);
    return {};
  }
  if (entry['room_id'] && entry['room_id'] !== roomId) {
    logger.warn(
      `Matrix trigger "${name}": room_id differs from call_room_id, so text replies in call threads won't reach this trigger`,
    );
  }
  return {
    call_room_id: roomId as string,
    livekit_url: url as string,
    livekit_internal_url: internalUrl as string,
  };
};

const mapEntry = (
  entry: Record<string, unknown>,
  logger: Logger,
): MatrixTrigger => ({
  name: entry['name'] as string,
  type: 'matrix',
  bot_name: entry['bot_name'] as string,
  homeserver_url: trimTrailingSlashes(entry['homeserver_url'] as string),
  access_token: interpolateEnvVars(entry['access_token'] as string),
  user_id: entry['user_id'] as string,
  cwd: normalizeCwd(entry['cwd'] as string, 'matrix trigger cwd'),
  ...(entry['room_id'] ? { room_id: entry['room_id'] as string } : {}),
  ...(entry['append_system_prompt']
    ? { append_system_prompt: entry['append_system_prompt'] as string }
    : {}),
  ...(entry['timeout_ms'] ? { timeout_ms: entry['timeout_ms'] as number } : {}),
  ...parseCallConfig(entry, logger),
});

export const parseMatrixTriggers = (
  raw: Record<string, unknown>[],
  logger: Logger,
): MatrixTrigger[] =>
  raw
    .filter((t) => t['type'] === 'matrix')
    .filter((t) => validate(t, logger))
    .map((entry) => mapEntry(entry, logger));
