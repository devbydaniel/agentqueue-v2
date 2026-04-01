import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
} from '@nestjs/common';
import { ApplicationError } from '../errors/base.error.js';

@Catch(ApplicationError)
export class ApplicationErrorFilter implements ExceptionFilter {
  catch(exception: ApplicationError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status(code: number): { json(body: unknown): void };
    }>();
    const httpException = exception.toHttpException();
    const body = httpException.getResponse();

    response.status(exception.statusCode).json(body);
  }
}
