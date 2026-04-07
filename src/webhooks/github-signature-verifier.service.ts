import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Verifies GitHub webhook HMAC-SHA256 signatures (`x-hub-signature-256` header)
 * against `GITHUB_WEBHOOK_SECRET`.
 */
@Injectable()
export class GithubSignatureVerifierService {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Verify the GitHub HMAC-SHA256 signature.
   * Throws `UnauthorizedException` on failure.
   */
  verify(rawBody: Buffer, signatureHeader: string): void {
    const secret = this.appConfig.githubWebhookSecret;
    if (!secret) {
      throw new UnauthorizedException(
        'GITHUB_WEBHOOK_SECRET is not configured',
      );
    }

    if (!signatureHeader) {
      throw new UnauthorizedException('Missing x-hub-signature-256 header');
    }

    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

    const sigBuffer = Buffer.from(signatureHeader);
    const expectedBuffer = Buffer.from(expected);

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}
