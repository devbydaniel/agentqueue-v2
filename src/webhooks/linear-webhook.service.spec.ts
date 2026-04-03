import { createHmac } from 'node:crypto';
import { LinearWebhookService } from './linear-webhook.service.js';
import { WebhookPayloadError } from './webhooks.errors.js';

describe('LinearWebhookService', () => {
  let service: LinearWebhookService;

  beforeEach(() => {
    service = new LinearWebhookService();
  });

  describe('verifySignature', () => {
    const secret = 'test-secret-key';
    const body = Buffer.from('{"action":"created"}');

    function computeSignature(rawBody: Buffer, signingSecret: string): string {
      return createHmac('sha256', signingSecret).update(rawBody).digest('hex');
    }

    it('should return true for a valid signature', () => {
      const sig = computeSignature(body, secret);
      expect(service.verifySignature(body, sig, secret)).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      const sig = computeSignature(body, 'wrong-secret');
      expect(service.verifySignature(body, sig, secret)).toBe(false);
    });

    it('should return false for a tampered body', () => {
      const sig = computeSignature(body, secret);
      const tampered = Buffer.from('{"action":"tampered"}');
      expect(service.verifySignature(tampered, sig, secret)).toBe(false);
    });

    it('should return false for a malformed signature (wrong length)', () => {
      expect(service.verifySignature(body, 'abcd', secret)).toBe(false);
    });
  });

  describe('verifyTimestamp', () => {
    it('should return true for a fresh timestamp', () => {
      const fresh = Date.now() - 5_000; // 5 seconds ago
      expect(service.verifyTimestamp(fresh)).toBe(true);
    });

    it('should return false for a stale timestamp (>60s)', () => {
      const stale = Date.now() - 120_000; // 2 minutes ago
      expect(service.verifyTimestamp(stale)).toBe(false);
    });

    it('should return true for exactly 60 seconds', () => {
      const edge = Date.now() - 60_000;
      expect(service.verifyTimestamp(edge)).toBe(true);
    });
  });

  describe('parsePayload', () => {
    it('should parse a valid "created" payload', () => {
      const payload = {
        action: 'created',
        type: 'AgentSession',
        data: {
          id: 'session-123',
          promptContext: 'Fix the bug in auth module',
          issueId: 'issue-456',
        },
      };

      const result = service.parsePayload(payload);

      expect(result.action).toBe('created');
      expect(result.agentSessionId).toBe('session-123');
      expect(result.promptContext).toBe('Fix the bug in auth module');
      expect(result.issueId).toBe('issue-456');
    });

    it('should parse a valid "prompted" payload', () => {
      const payload = {
        action: 'prompted',
        type: 'AgentSession',
        data: {
          id: 'session-123',
        },
        agentActivity: {
          content: {
            type: 'prompt',
            body: 'Can you also fix the tests?',
          },
        },
      };

      const result = service.parsePayload(payload);

      expect(result.action).toBe('prompted');
      expect(result.agentSessionId).toBe('session-123');
      expect(result.agentActivityBody).toBe('Can you also fix the tests?');
    });

    it('should throw for null body', () => {
      expect(() => service.parsePayload(null)).toThrow(WebhookPayloadError);
    });

    it('should throw for non-object body', () => {
      expect(() => service.parsePayload('string')).toThrow(WebhookPayloadError);
    });

    it('should throw for unsupported type', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'Issue',
          data: { id: 'x' },
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw for unsupported action', () => {
      expect(() =>
        service.parsePayload({
          action: 'deleted',
          type: 'AgentSession',
          data: { id: 'x' },
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw when data is missing', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw when data.id is missing', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: { promptContext: 'hello' },
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw when promptContext is missing for created action', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: { id: 'session-123' },
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw when agentActivity.content.body is missing for prompted action', () => {
      expect(() =>
        service.parsePayload({
          action: 'prompted',
          type: 'AgentSession',
          data: { id: 'session-123' },
        }),
      ).toThrow(WebhookPayloadError);
    });

    it('should throw when agentActivity.content is empty for prompted action', () => {
      expect(() =>
        service.parsePayload({
          action: 'prompted',
          type: 'AgentSession',
          data: { id: 'session-123' },
          agentActivity: { content: {} },
        }),
      ).toThrow(WebhookPayloadError);
    });
  });

  describe('createLinearClient', () => {
    it('should return a LinearClient instance', () => {
      const client = service.createLinearClient('test-api-key');
      expect(client).toBeDefined();
    });
  });
});
