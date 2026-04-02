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
  signal?: string;
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

    // Extract signal from agentActivity (e.g. "stop")
    const agentActivity = payload['agentActivity'] as
      | Record<string, unknown>
      | undefined;
    const signal = agentActivity?.['signal'] as string | undefined;

    return {
      action,
      agentSessionId: data['id'] as string,
      promptContext: data['promptContext'] as string | undefined,
      agentActivityBody: data['agentActivityBody'] as string | undefined,
      issueId: data['issueId'] as string | undefined,
      signal,
    };
  }

  createLinearClient(apiKey: string): LinearClient {
    return new LinearClient({ apiKey });
  }

  private validateTypeAndAction(payload: Record<string, unknown>): void {
    const type = payload['type'];
    if (type !== 'AgentSession' && type !== 'AgentSessionEvent') {
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
    // Linear sends session data under "agentSession" or "data"
    const data = (payload['agentSession'] ?? payload['data']) as
      | Record<string, unknown>
      | undefined;
    if (!data) {
      throw new WebhookPayloadError('missing agentSession/data field');
    }

    if (!data['id']) {
      throw new WebhookPayloadError('missing data.id (agentSessionId)');
    }

    const action = payload['action'] as string;
    if (action === 'created') {
      this.extractCreatedFields(payload, data);
    } else if (action === 'prompted') {
      this.extractPromptedFields(payload, data);
    }

    return data;
  }

  private extractCreatedFields(
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    // promptContext can be at top level of the webhook payload or inside agentSession
    const promptContext =
      (data['promptContext'] as string | undefined) ??
      (payload['promptContext'] as string | undefined);
    if (!promptContext) {
      throw new WebhookPayloadError(
        'missing promptContext for created action',
      );
    }
    data['promptContext'] = promptContext;
  }

  private extractPromptedFields(
    payload: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    // Body and signal come from agentActivity
    // A stop signal may not include a body, so only require body for non-stop prompts
    const agentActivity = payload['agentActivity'] as
      | Record<string, unknown>
      | undefined;
    if (agentActivity?.['body']) {
      data['agentActivityBody'] = agentActivity['body'];
    }
    const signal = agentActivity?.['signal'] as string | undefined;
    if (!data['agentActivityBody'] && signal !== 'stop') {
      throw new WebhookPayloadError(
        'missing agentActivity.body for prompted action',
      );
    }
  }
}
