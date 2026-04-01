import { ApplicationError } from '../common/errors/base.error.js';

export enum TriggerErrorCode {
  TRIGGERS_CONFIG_NOT_FOUND = 'TRIGGERS_CONFIG_NOT_FOUND',
  TRIGGERS_CONFIG_PARSE_ERROR = 'TRIGGERS_CONFIG_PARSE_ERROR',
}

export abstract class TriggerError extends ApplicationError {
  constructor(
    message: string,
    code: TriggerErrorCode,
    statusCode: number = 500,
  ) {
    super(message, code, statusCode);
  }
}

export class TriggersConfigNotFoundError extends TriggerError {
  constructor(configPath: string) {
    super(
      `Triggers config not found at ${configPath}`,
      TriggerErrorCode.TRIGGERS_CONFIG_NOT_FOUND,
    );
  }
}

export class TriggersConfigParseError extends TriggerError {
  constructor(detail: string) {
    super(
      `Failed to parse triggers config: ${detail}`,
      TriggerErrorCode.TRIGGERS_CONFIG_PARSE_ERROR,
    );
  }
}
