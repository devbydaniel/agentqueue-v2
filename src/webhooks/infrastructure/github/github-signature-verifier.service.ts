import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../../../config/app-config.service.js';
import { WebhookSignatureError } from '../../application/webhooks.errors.js';

/**
 * Verifies GitHub webhook HMAC-SHA256 signatures (`x-hub-signature-256` header)
 * against `GITHUB_WEBHOOK_SECRET`. Stateless I/O — pure verifier.
 */
@Injectable()
export class GithubSignatureVerifierService {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Verify the GitHub HMAC-SHA256 signature.
   * Throws `WebhookSignatureError` on failure.
   */
  verify(rawBody: Buffer, signatureHeader: string): void {
    const secret = this.appConfig.githubWebhookSecret;
    if (!secret) {
      throw new WebhookSignatureError(
        'GITHUB_WEBHOOK_SECRET is not configured',
      );
    }

    if (!signatureHeader) {
      throw new WebhookSignatureError('Missing x-hub-signature-256 header');
    }

    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    const sigBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new WebhookSignatureError();
    }
  }
}
