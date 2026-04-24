import type { Logger } from '@nestjs/common';
import { normalizeCwd } from '../../common/utils/cwd-path.js';

export const hasRequiredFields = (
  trigger: Record<string, unknown>,
  fields: readonly string[],
  logger: Logger,
  label: string,
): boolean => {
  const missing = fields.filter((f) => {
    // eslint-disable-next-line security/detect-object-injection -- f is from a hardcoded REQUIRED list, not user input
    const value = trigger[f];
    return value === undefined || value === null || value === '';
  });
  if (missing.length === 0) return true;
  logger.warn(
    `${label} missing required fields (${missing.join(', ')}): ${JSON.stringify(trigger)}`,
  );
  return false;
};

export const validateCwd = (
  cwd: string,
  triggerName: string,
  kind: string,
  logger: Logger,
): boolean => {
  try {
    normalizeCwd(cwd, `${kind} trigger "${triggerName}" cwd`);
    return true;
  } catch (error) {
    logger.warn(
      `Skipping ${kind} trigger "${triggerName}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
};
