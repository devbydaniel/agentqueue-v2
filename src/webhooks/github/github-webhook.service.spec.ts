import { createHmac } from 'node:crypto';
import { GithubWebhookService } from './github-webhook.service.js';
import { WebhookSignatureError } from '../webhooks.errors.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';

function makeService(overrides: {
  secret?: string;
  triggers?: GithubTrigger[];
  resolveRepoFn?: (name: string) => string;
  executeFn?: jest.Mock;
  beforeHookFn?: jest.Mock;
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

  const beforeHookFn =
    overrides.beforeHookFn ??
    jest.fn(async () => ({ proceed: true, output: '' }));
  const beforeHookService = {
    run: beforeHookFn,
  };

  return {
    service: new GithubWebhookService(
      appConfig as never,
      triggerConfigService as never,
      agentfilesConfigService as never,
      executeRunUseCase as never,
      beforeHookService as never,
    ),
    executeFn,
    beforeHookFn,
  };
}

/** Flush pending microtasks so async fire-and-forget chains complete. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// Top-level helpers so the inline jest.fn() callbacks below stay shallow
// (sonarjs/no-nested-functions caps nesting at 4 levels).
function hookProceedFn(
  output: string,
): () => Promise<{ proceed: true; output: string }> {
  return () => Promise.resolve({ proceed: true, output });
}

function hookSkipFn(): () => Promise<{ proceed: false; output: string }> {
  return () => Promise.resolve({ proceed: false, output: '' });
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

    describe('before hook', () => {
      const triggerWithHook: GithubTrigger = {
        ...prReviewTrigger,
        before: '/scripts/check.sh',
        prompt: 'PR review context: {{before_output}}',
      };

      it('does not call the hook when trigger.before is unset', () => {
        const { service, beforeHookFn } = makeService({
          secret: 'sec',
          triggers: [prReviewTrigger],
        });

        service.handleEvent('pull_request_review', payload);

        expect(beforeHookFn).not.toHaveBeenCalled();
      });

      it('runs the hook with the trigger label before executing', async () => {
        const { service, beforeHookFn, executeFn } = makeService({
          secret: 'sec',
          triggers: [triggerWithHook],
          beforeHookFn: jest.fn(hookProceedFn('gathered')),
        });

        service.handleEvent('pull_request_review', payload);
        await flush();

        expect(beforeHookFn).toHaveBeenCalledWith(
          '/scripts/check.sh',
          'github trigger "address-review"',
        );
        expect(executeFn).toHaveBeenCalled();
      });

      it('substitutes {{before_output}} in the prompt with hook stdout', async () => {
        const { service, executeFn } = makeService({
          secret: 'sec',
          triggers: [triggerWithHook],
          beforeHookFn: jest.fn(hookProceedFn('gathered context')),
        });

        service.handleEvent('pull_request_review', payload);
        await flush();

        expect(executeFn).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: 'PR review context: gathered context',
          }),
        );
      });

      it('substitutes {{before_output}} with empty string when hook output is empty', async () => {
        const { service, executeFn } = makeService({
          secret: 'sec',
          triggers: [triggerWithHook],
          beforeHookFn: jest.fn(hookProceedFn('')),
        });

        service.handleEvent('pull_request_review', payload);
        await flush();

        expect(executeFn).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: 'PR review context: ',
          }),
        );
      });

      it('skips the run when the hook returns proceed: false', async () => {
        const { service, beforeHookFn, executeFn } = makeService({
          secret: 'sec',
          triggers: [triggerWithHook],
          beforeHookFn: jest.fn(hookSkipFn()),
        });

        const result = service.handleEvent('pull_request_review', payload);
        await flush();

        // handleEvent still reports the trigger as matched
        expect(result.triggered).toBe(1);
        expect(beforeHookFn).toHaveBeenCalled();
        expect(executeFn).not.toHaveBeenCalled();
      });
    });
  });
});
