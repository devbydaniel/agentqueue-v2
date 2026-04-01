import { ApplicationError } from '../common/errors/base.error.js';

export enum ConfigErrorCode {
  REPO_NOT_FOUND = 'REPO_NOT_FOUND',
  CONFIG_PARSE_ERROR = 'CONFIG_PARSE_ERROR',
  UNEXPECTED_CONFIG_ERROR = 'UNEXPECTED_CONFIG_ERROR',
}

export abstract class ConfigError extends ApplicationError {
  constructor(
    message: string,
    code: ConfigErrorCode,
    statusCode: number = 400,
  ) {
    super(message, code, statusCode);
  }
}

export class RepoNotFoundError extends ConfigError {
  constructor(repoName: string) {
    super(
      `Repo "${repoName}" not found in agentfiles config`,
      ConfigErrorCode.REPO_NOT_FOUND,
      404,
    );
  }
}

export class ConfigParseError extends ConfigError {
  constructor(detail: string) {
    super(
      `Failed to parse agentfiles config: ${detail}`,
      ConfigErrorCode.CONFIG_PARSE_ERROR,
      500,
    );
  }
}

export class UnexpectedConfigError extends ConfigError {
  constructor(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unexpected config error';
    super(message, ConfigErrorCode.UNEXPECTED_CONFIG_ERROR, 500);
  }
}
