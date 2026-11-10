import { createHmac } from 'node:crypto';
import { LinearWebhookParserService } from './linear-webhook-parser.service.js';
import { BadRequestException } from '@nestjs/common';

describe('LinearWebhookParserService', () => {
  let service: LinearWebhookParserService;

  beforeEach(() => {
    service = new LinearWebhookParserService();
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
    const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

    it('should return true for a fresh timestamp', () => {
      const fresh = Date.now() - 5_000; // 5 seconds ago
      expect(service.verifyTimestamp(fresh)).toBe(true);
    });

    it('should return true for a timestamp a few minutes old', () => {
      const recent = Date.now() - 5 * 60_000; // 5 minutes ago
      expect(service.verifyTimestamp(recent)).toBe(true);
    });

    it('should return false for a timestamp older than 8 hours', () => {
      const stale = Date.now() - (EIGHT_HOURS_MS + 60_000);
      expect(service.verifyTimestamp(stale)).toBe(false);
    });

    it('should return true at exactly 8 hours', () => {
      const edge = Date.now() - EIGHT_HOURS_MS;
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
      expect(() => service.parsePayload(null)).toThrow(BadRequestException);
    });

    it('should throw for non-object body', () => {
      expect(() => service.parsePayload('string')).toThrow(BadRequestException);
    });

    it('should throw for unsupported type', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'Issue',
          data: { id: 'x' },
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw for unsupported action', () => {
      expect(() =>
        service.parsePayload({
          action: 'deleted',
          type: 'AgentSession',
          data: { id: 'x' },
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw when data is missing', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw when data.id is missing', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: { promptContext: 'hello' },
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw when promptContext is missing for created action', () => {
      expect(() =>
        service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: { id: 'session-123' },
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw when agentActivity.content.body is missing for prompted action', () => {
      expect(() =>
        service.parsePayload({
          action: 'prompted',
          type: 'AgentSession',
          data: { id: 'session-123' },
        }),
      ).toThrow(BadRequestException);
    });

    it('should throw when agentActivity.content is empty for prompted action', () => {
      expect(() =>
        service.parsePayload({
          action: 'prompted',
          type: 'AgentSession',
          data: { id: 'session-123' },
          agentActivity: { content: {} },
        }),
      ).toThrow(BadRequestException);
    });

    describe('eventType derivation', () => {
      it('should set eventType to "assigned" for created payload without commentId', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-1',
            promptContext: 'Fix the bug',
            issueId: 'issue-1',
          },
        });

        expect(result.eventType).toBe('assigned');
        expect(result.commentId).toBeUndefined();
        expect(result.sessionType).toBeUndefined();
      });

      it('should set eventType to "assigned" for an assignment session with a comment thread', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSessionEvent',
          agentSession: {
            id: 'session-2',
            promptContext:
              '<issue identifier="AYC-1">…</issue>\n<user-request>\nWork on AYC-1\n</user-request>',
            issueId: 'issue-1',
            commentId: 'comment-1',
            type: 'commentThread',
            sourceMetadata: null,
          },
        });

        expect(result.eventType).toBe('assigned');
        expect(result.commentId).toBe('comment-1');
        expect(result.sessionType).toBe('commentThread');
      });

      it('should set eventType to "mentioned" when the session comes from a comment', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSessionEvent',
          agentSession: {
            id: 'session-3',
            promptContext: 'Look at this',
            issueId: 'issue-1',
            commentId: 'comment-1',
            type: 'commentThread',
            sourceMetadata: {
              type: 'comment',
              agentSessionMetadata: { sourceCommentId: 'comment-1' },
            },
          },
        });

        expect(result.eventType).toBe('mentioned');
      });

      it('should set eventType to "mentioned" when sourceCommentId is set', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-4',
            promptContext: 'Look at this',
            commentId: 'comment-2',
            sourceCommentId: 'comment-1',
          },
        });

        expect(result.eventType).toBe('mentioned');
      });

      it('should set eventType to "mentioned" when the prompt context has a directive thread', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-5',
            promptContext:
              '<issue identifier="AYC-1"></issue>\n<primary-directive-thread comment-id="comment-1"><comment>@aycdev help</comment></primary-directive-thread>',
            commentId: 'comment-1',
          },
        });

        expect(result.eventType).toBe('mentioned');
      });

      it('should not set eventType for prompted action', () => {
        const result = service.parsePayload({
          action: 'prompted',
          type: 'AgentSession',
          data: { id: 'session-1', commentId: 'comment-1' },
          agentActivity: {
            content: { type: 'prompt', body: 'Follow up' },
          },
        });

        expect(result.eventType).toBeUndefined();
      });
    });
  });
});
