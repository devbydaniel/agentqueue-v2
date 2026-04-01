import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
import { WebhookPayloadError } from './webhooks.errors.js';

export interface LinearWebhookPayload {
  action: string;
  agentSessionId: string;
  promptContext?: string;
  agentActivityBody?: string;
  issueId?: string;
}

@Injectable()
export class LinearWebhookService {
  verifySignature(rawBody: Buffer, signature: string, secret: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(sigBuffer, expectedBuffer);
  }

  verifyTimestamp(webhookTimestamp: number): boolean {
    const now = Date.now();
    const age = now - webhookTimestamp;
    return age <= 60_000;
  }

  parsePayload(body: unknown): LinearWebhookPayload {
    if (!body || typeof body !== 'object') {
      throw new WebhookPayloadError('body must be an object');
    }

    const payload = body as Record<string, unknown>;
    this.validateTypeAndAction(payload);

    const data = this.extractData(payload);
    const action = payload['action'] as 'created' | 'prompted';

    return {
      action,
      agentSessionId: data['id'] as string,
      promptContext: data['promptContext'] as string | undefined,
      agentActivityBody: data['agentActivityBody'] as string | undefined,
      issueId: data['issueId'] as string | undefined,
    };
  }

  createLinearClient(apiKey: string): LinearClient {
    return new LinearClient({ apiKey });
  }

  private validateTypeAndAction(payload: Record<string, unknown>): void {
    const type = payload['type'];
    if (type !== 'AgentSession') {
      throw new WebhookPayloadError(
        `unsupported webhook type: ${String(type)}`,
      );
    }

    const action = payload['action'];
    if (action !== 'created' && action !== 'prompted') {
      throw new WebhookPayloadError(`unsupported action: ${String(action)}`);
    }
  }

  private extractData(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const data = payload['data'] as Record<string, unknown> | undefined;
    if (!data) {
      throw new WebhookPayloadError('missing data field');
    }

    const agentSessionId = data['id'] as string | undefined;
    if (!agentSessionId) {
      throw new WebhookPayloadError('missing data.id (agentSessionId)');
    }

    const action = payload['action'] as string;
    if (action === 'created' && !data['promptContext']) {
      throw new WebhookPayloadError(
        'missing data.promptContext for created action',
      );
    }
    if (action === 'prompted' && !data['agentActivityBody']) {
      throw new WebhookPayloadError(
        'missing data.agentActivityBody for prompted action',
      );
    }

    return data;
  }
}
