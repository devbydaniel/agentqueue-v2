import { ApplicationError } from '../common/errors/base.error.js';

export enum WebhookErrorCode {
  SIGNATURE_INVALID = 'WEBHOOK_SIGNATURE_INVALID',
  NOT_ENABLED = 'WEBHOOK_NOT_ENABLED',
  PAYLOAD_INVALID = 'WEBHOOK_PAYLOAD_INVALID',
}

export abstract class WebhookError extends ApplicationError {
  constructor(
    message: string,
    code: WebhookErrorCode,
    statusCode: number = 400,
  ) {
    super(message, code, statusCode);
  }
}

export class WebhookSignatureError extends WebhookError {
  constructor(detail = 'Invalid webhook signature') {
    super(detail, WebhookErrorCode.SIGNATURE_INVALID, 401);
  }
}

export class WebhookNotEnabledError extends WebhookError {
  constructor(agentName?: string) {
    const detail = agentName
      ? `Linear webhook not configured for agent '${agentName}'`
      : 'Linear webhook integration is not configured';
    super(detail, WebhookErrorCode.NOT_ENABLED, 404);
  }
}

export class WebhookPayloadError extends WebhookError {
  constructor(detail: string) {
    super(
      `Invalid webhook payload: ${detail}`,
      WebhookErrorCode.PAYLOAD_INVALID,
      400,
    );
  }
}
