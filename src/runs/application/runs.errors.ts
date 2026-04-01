import { ApplicationError } from '../../common/errors/base.error.js';

export enum RunErrorCode {
  UNEXPECTED_RUN_ERROR = 'UNEXPECTED_RUN_ERROR',
}

export abstract class RunError extends ApplicationError {
  constructor(message: string, code: RunErrorCode, statusCode: number = 400) {
    super(message, code, statusCode);
  }
}

export class UnexpectedRunError extends RunError {
  constructor(error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unexpected run error';
    super(message, RunErrorCode.UNEXPECTED_RUN_ERROR, 500);
  }
}
