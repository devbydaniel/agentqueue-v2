import { createHmac } from 'node:crypto';
import { GithubSignatureVerifierService } from './github-signature-verifier.service.js';
import { UnauthorizedException } from '@nestjs/common';
import type { AppConfigService } from '../config/app-config.service.js';

describe('GithubSignatureVerifierService', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"action":"submitted"}');

  function makeService(secretValue: string | undefined) {
    const appConfig = { githubWebhookSecret: secretValue } as AppConfigService;
    return new GithubSignatureVerifierService(appConfig);
  }

  it('should pass for a valid signature', () => {
    const service = makeService(secret);
    const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

    expect(() => service.verify(body, sig)).not.toThrow();
  });

  it('should throw for an invalid signature', () => {
    const service = makeService(secret);
    const sig = `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`;

    expect(() => service.verify(body, sig)).toThrow(UnauthorizedException);
  });

  it('should throw when secret is not configured', () => {
    const service = makeService(undefined);

    expect(() => service.verify(body, 'sha256=abc')).toThrow(
      UnauthorizedException,
    );
  });

  it('should throw for an empty signature header', () => {
    const service = makeService(secret);

    expect(() => service.verify(body, '')).toThrow(UnauthorizedException);
  });
});
