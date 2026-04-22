import { BadRequestException, Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
import type { LinearEventType } from '../config/trigger-config.interface.js';

export interface LinearWebhookPayload {
  action: string;
  agentSessionId: string;
  promptContext?: string;
  agentActivityBody?: string;
  issueId?: string;
  signal?: string;
  /** Only set for action: "created". Derived from commentId / session type. */
  eventType?: LinearEventType;
  commentId?: string;
  sessionType?: string;
}

@Injectable()
export class LinearWebhookParserService {
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
    return age <= 8 * 60 * 60 * 1000;
  }

  parsePayload(body: unknown): LinearWebhookPayload {
    if (!body || typeof body !== 'object') {
      throw new BadRequestException(
        'Invalid webhook payload: body must be an object',
      );
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

    const commentId = data['commentId'] as string | undefined;
    const sessionType = data['type'] as string | undefined;

    // Derive eventType for "created" actions based on session structure
    let eventType: LinearEventType | undefined;
    if (action === 'created') {
      eventType =
        commentId || sessionType === 'commentThread' ? 'mentioned' : 'assigned';
    }

    return {
      action,
      agentSessionId: data['id'] as string,
      promptContext: data['promptContext'] as string | undefined,
      agentActivityBody: data['agentActivityBody'] as string | undefined,
      issueId: data['issueId'] as string | undefined,
      signal,
      eventType,
      commentId,
      sessionType,
    };
  }

  createLinearClient(apiKey: string): LinearClient {
    return new LinearClient({ apiKey });
  }

  private validateTypeAndAction(payload: Record<string, unknown>): void {
    const type = payload['type'];
    if (type !== 'AgentSession' && type !== 'AgentSessionEvent') {
      throw new BadRequestException(
        `Invalid webhook payload: unsupported webhook type: ${String(type)}`,
      );
    }

    const action = payload['action'];
    if (action !== 'created' && action !== 'prompted') {
      throw new BadRequestException(
        `Invalid webhook payload: unsupported action: ${String(action)}`,
      );
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
      throw new BadRequestException(
        'Invalid webhook payload: missing agentSession/data field',
      );
    }

    if (!data['id']) {
      throw new BadRequestException(
        'Invalid webhook payload: missing data.id (agentSessionId)',
      );
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
      throw new BadRequestException(
        'Invalid webhook payload: missing promptContext for created action',
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
    // The user's message is nested inside agentActivity.content.body
    // (agentActivity.content is a JSON object like { type: "prompt", body: "..." })
    const content = agentActivity?.['content'] as
      | Record<string, unknown>
      | undefined;
    if (content?.['body']) {
      data['agentActivityBody'] = content['body'];
    }
    const signal = agentActivity?.['signal'] as string | undefined;
    if (!data['agentActivityBody'] && signal !== 'stop') {
      throw new BadRequestException(
        'Invalid webhook payload: missing agentActivity.content.body for prompted action',
      );
    }
  }
}
