import { createHmac } from 'node:crypto';
import { GithubWebhookService } from './github-webhook.service.js';
import { WebhookSignatureError } from '../webhooks.errors.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';

function makeService(overrides: {
  secret?: string;
  triggers?: GithubTrigger[];
  resolveRepoFn?: (name: string) => string;
  executeFn?: jest.Mock;
}) {
  const appConfig = {
    githubWebhookSecret: overrides.secret,
  };

  const triggerConfigService = {
    getGithubTriggers: jest.fn(() => overrides.triggers ?? []),
  };

  const agentfilesConfigService = {
    resolveRepo:
      overrides.resolveRepoFn ?? jest.fn((name: string) => `/repos/${name}`),
  };

  const executeFn =
    overrides.executeFn ?? jest.fn(async () => ({ success: true }));
  const executeRunUseCase = {
    execute: executeFn,
  };

  return {
    service: new GithubWebhookService(
      appConfig as never,
      triggerConfigService as never,
      agentfilesConfigService as never,
      executeRunUseCase as never,
    ),
    executeFn,
  };
}

describe('GithubWebhookService', () => {
  describe('verifySignature', () => {
    const secret = 'test-webhook-secret';
    const body = Buffer.from('{"action":"submitted"}');

    it('should pass for a valid signature', () => {
      const { service } = makeService({ secret });
      const sig = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

      expect(() => service.verifySignature(body, sig)).not.toThrow();
    });

    it('should throw for an invalid signature', () => {
      const { service } = makeService({ secret });
      const sig = `sha256=${createHmac('sha256', 'wrong').update(body).digest('hex')}`;

      expect(() => service.verifySignature(body, sig)).toThrow(
        WebhookSignatureError,
      );
    });

    it('should throw when secret is not configured', () => {
      const { service } = makeService({ secret: undefined });

      expect(() => service.verifySignature(body, 'sha256=abc')).toThrow(
        WebhookSignatureError,
      );
    });

    it('should throw for an empty signature header', () => {
      const { service } = makeService({ secret });

      expect(() => service.verifySignature(body, '')).toThrow(
        WebhookSignatureError,
      );
    });
  });

  describe('handleEvent', () => {
    const prReviewTrigger: GithubTrigger = {
      name: 'address-review',
      type: 'github',
      events: ['pull_request_review'],
      target: '{{repository.name}}',
      prompt:
        'Address review on PR #{{pull_request.number}} by {{review.user.login}}.',
      filters: [
        { field: 'action', equals: 'submitted' },
        { field: 'review.state', in: ['changes_requested', 'commented'] },
      ],
    };

    const payload = {
      action: 'submitted',
      repository: { name: 'my-repo', full_name: 'org/my-repo' },
      pull_request: {
        number: 42,
        html_url: 'https://github.com/org/my-repo/pull/42',
      },
      review: {
        state: 'changes_requested',
        user: { login: 'alice' },
        body: 'Fix tests',
      },
    };

    it('should match a trigger and fire a run', () => {
      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [prReviewTrigger],
      });

      const result = service.handleEvent('pull_request_review', payload);

      expect(result.triggered).toBe(1);
      // Run is fired async — verify execute was called
      expect(executeFn).toHaveBeenCalledWith(
        expect.objectContaining({
          repo: 'my-repo',
          prompt: 'Address review on PR #42 by alice.',
        }),
      );
    });

    it('should not match when event type does not match', () => {
      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [prReviewTrigger],
      });

      const result = service.handleEvent('issues', payload);

      expect(result.triggered).toBe(0);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('should not match when filters do not pass', () => {
      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [prReviewTrigger],
      });

      const approvedPayload = {
        ...payload,
        review: { ...payload.review, state: 'approved' },
      };

      const result = service.handleEvent(
        'pull_request_review',
        approvedPayload,
      );

      expect(result.triggered).toBe(0);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('should match multiple triggers', () => {
      const secondTrigger: GithubTrigger = {
        name: 'log-review',
        type: 'github',
        events: ['pull_request_review'],
        target: '{{repository.name}}',
        prompt: 'Log review.',
      };

      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [prReviewTrigger, secondTrigger],
      });

      const result = service.handleEvent('pull_request_review', payload);

      expect(result.triggered).toBe(2);
      expect(executeFn).toHaveBeenCalledTimes(2);
    });

    it('should skip when resolved repo is not configured', () => {
      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [prReviewTrigger],
        resolveRepoFn: () => {
          throw new Error('not found');
        },
      });

      const result = service.handleEvent('pull_request_review', payload);

      expect(result.triggered).toBe(1);
      expect(executeFn).not.toHaveBeenCalled();
    });

    it('should interpolate system prompts with payload values', () => {
      const triggerWithSystem: GithubTrigger = {
        ...prReviewTrigger,
        prepend_system_prompt: 'You are working on {{repository.full_name}}.',
        append_system_prompt: 'PR URL: {{pull_request.html_url}}',
      };

      const { service, executeFn } = makeService({
        secret: 'sec',
        triggers: [triggerWithSystem],
      });

      service.handleEvent('pull_request_review', payload);

      expect(executeFn).toHaveBeenCalledWith(
        expect.objectContaining({
          prependSystemPrompt: 'You are working on org/my-repo.',
          appendSystemPrompt: 'PR URL: https://github.com/org/my-repo/pull/42',
        }),
      );
    });
  });
});
