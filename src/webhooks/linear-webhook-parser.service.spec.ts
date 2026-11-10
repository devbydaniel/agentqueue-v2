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
      // Linear attaches a thread root comment to every session and its
      // session `type` enum has the single value "commentThread", so neither
      // tells a delegation from a mention. Only a mention carries
      // sourceMetadata with the comment the agent was mentioned in.
      it('should set eventType to "assigned" for a delegated session that has a thread comment', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-1',
            promptContext: 'Fix the bug',
            issueId: 'issue-1',
            commentId: 'thread-root-comment',
            type: 'commentThread',
          },
        });

        expect(result.eventType).toBe('assigned');
        expect(result.commentId).toBe('thread-root-comment');
        expect(result.sessionType).toBe('commentThread');
        expect(result.sourceCommentId).toBeUndefined();
      });

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
      });

      it('should set eventType to "mentioned" when sourceMetadata names the mentioning comment', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-2',
            promptContext: 'Look at this',
            issueId: 'issue-1',
            commentId: 'thread-root-comment',
            type: 'commentThread',
            sourceMetadata: {
              type: 'comment',
              agentSessionMetadata: { sourceCommentId: 'comment-1' },
            },
          },
        });

        expect(result.eventType).toBe('mentioned');
        expect(result.sourceCommentId).toBe('comment-1');
      });

      it('should set eventType to "mentioned" when sourceMetadata has type "comment" without an id', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-3',
            promptContext: 'Check this thread',
            issueId: 'issue-1',
            sourceMetadata: { type: 'comment' },
          },
        });

        expect(result.eventType).toBe('mentioned');
        expect(result.sourceCommentId).toBeUndefined();
      });

      it('should ignore sourceMetadata of another type', () => {
        const result = service.parsePayload({
          action: 'created',
          type: 'AgentSession',
          data: {
            id: 'session-4',
            promptContext: 'Fix the bug',
            issueId: 'issue-1',
            sourceMetadata: { type: 'slack' },
          },
        });

        expect(result.eventType).toBe('assigned');
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
