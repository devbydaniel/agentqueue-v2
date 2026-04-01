import { HttpException } from '@nestjs/common';

export abstract class ApplicationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number = 400) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }

  toHttpException(): HttpException {
    return new HttpException(
      {
        statusCode: this.statusCode,
        code: this.code,
        message: this.message,
      },
      this.statusCode,
    );
  }
}
