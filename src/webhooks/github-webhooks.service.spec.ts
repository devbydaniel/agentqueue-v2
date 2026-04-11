/* eslint-disable security/detect-non-literal-fs-filename */
import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GithubWebhooksService } from './github-webhooks.service.js';
import { GithubSignatureVerifierService } from './github-signature-verifier.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { RunsService } from '../runs/runs.service.js';
import { BeforeHookService } from '../triggers/before-hook.service.js';
import type { GithubTrigger } from '../config/trigger-config.interface.js';

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

/** Flush pending microtasks so async fire-and-forget chains complete. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('GithubWebhooksService', () => {
  let service: GithubWebhooksService;
  let signatureVerifier: GithubSignatureVerifierService;
  let triggerConfigService: TriggerConfigService;
  let runsService: RunsService;
  let beforeHookService: BeforeHookService;
  let tmpDir: string;

  const validRawBody = Buffer.from(JSON.stringify(payload));
  const validSignature = 'sha256=fake-signature';

  function makePrReviewTrigger(): GithubTrigger {
    return {
      name: 'address-review',
      type: 'github',
      events: ['pull_request_review'],
      cwd: path.join(tmpDir, '{{repository.name}}'),
      prompt:
        'Address review on PR #{{pull_request.number}} by {{review.user.login}}.',
      filters: [
        { field: 'action', equals: 'submitted' },
        { field: 'review.state', in: ['changes_requested', 'commented'] },
      ],
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-webhooks-test-'));
    fs.mkdirSync(path.join(tmpDir, 'my-repo'));

    const module = await Test.createTestingModule({
      providers: [
        GithubWebhooksService,
        {
          provide: GithubSignatureVerifierService,
          useValue: { verify: jest.fn() },
        },
        {
          provide: TriggerConfigService,
          useValue: { getGithubTriggers: jest.fn(() => []) },
        },
        {
          provide: RunsService,
          useValue: {
            enqueue: jest
              .fn()
              .mockResolvedValue({ runId: 'run-abc', status: 'waiting' }),
          },
        },
        {
          provide: BeforeHookService,
          useValue: {
            run: jest.fn().mockResolvedValue({ proceed: true, output: '' }),
          },
        },
      ],
    }).compile();

    service = module.get(GithubWebhooksService);
    signatureVerifier = module.get(GithubSignatureVerifierService);
    triggerConfigService = module.get(TriggerConfigService);
    runsService = module.get(RunsService);
    beforeHookService = module.get(BeforeHookService);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('handleWebhook — signature verification', () => {
    it('should throw UnauthorizedException when rawBody is missing', () => {
      expect(() =>
        service.handleWebhook({
          rawBody: undefined,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        }),
      ).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException when signature header is missing', () => {
      expect(() =>
        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: undefined,
          eventType: 'pull_request_review',
          body: payload,
        }),
      ).toThrow(UnauthorizedException);
    });

    it('should call the signature verifier with raw body and signature', () => {
      service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });

      expect(signatureVerifier.verify).toHaveBeenCalledWith(
        validRawBody,
        validSignature,
      );
    });

    it('should propagate verifier failures (UnauthorizedException)', () => {
      (signatureVerifier.verify as jest.Mock).mockImplementation(() => {
        throw new UnauthorizedException('Invalid webhook signature');
      });

      expect(() =>
        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        }),
      ).toThrow(UnauthorizedException);
    });
  });

  describe('handleWebhook — trigger matching', () => {
    it('should match a trigger and fire it', async () => {
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
      ]);

      const result = service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(result.triggered).toBe(1);
      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'github',
          triggerName: 'address-review',
          cwd: path.join(tmpDir, 'my-repo'),
          prompt: 'Address review on PR #42 by alice.',
        }),
      );
    });

    it('should not match when the event type does not match', () => {
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
      ]);

      const result = service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'issues',
        body: payload,
      });

      expect(result.triggered).toBe(0);
      expect(runsService.enqueue).not.toHaveBeenCalled();
    });

    it('should not match when filters do not pass', () => {
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
      ]);

      const approvedPayload = {
        ...payload,
        review: { ...payload.review, state: 'approved' },
      };

      const result = service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: approvedPayload,
      });

      expect(result.triggered).toBe(0);
      expect(runsService.enqueue).not.toHaveBeenCalled();
    });

    it('should match and fire multiple triggers', async () => {
      const secondTrigger: GithubTrigger = {
        name: 'log-review',
        type: 'github',
        events: ['pull_request_review'],
        cwd: path.join(tmpDir, '{{repository.name}}'),
        prompt: 'Log review.',
      };
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
        secondTrigger,
      ]);

      const result = service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(result.triggered).toBe(2);
      expect(runsService.enqueue).toHaveBeenCalledTimes(2);
    });

    it('should swallow per-trigger fire failures (fire-and-forget)', async () => {
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
      ]);
      (runsService.enqueue as jest.Mock).mockRejectedValueOnce(
        new Error('boom'),
      );

      const result = service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      // Even though fire failed, we still return the matched count
      expect(result.triggered).toBe(1);
      await flush();
    });
  });

  describe('fireTrigger — interpolation, gating, dispatch', () => {
    beforeEach(() => {
      // Always have one matching trigger so handleWebhook reaches fireTrigger
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        makePrReviewTrigger(),
      ]);
    });

    it('should interpolate the cwd and prompt and dispatch the run', async () => {
      service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: path.join(tmpDir, 'my-repo'),
          prompt: 'Address review on PR #42 by alice.',
        }),
      );
    });

    it('should skip when resolved cwd is not a usable directory', async () => {
      fs.rmSync(path.join(tmpDir, 'my-repo'), { recursive: true, force: true });

      service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(runsService.enqueue).not.toHaveBeenCalled();
    });

    it('should skip when prompt exceeds the max length', async () => {
      const huge = 'x'.repeat(60_000);
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        { ...makePrReviewTrigger(), prompt: huge },
      ]);

      service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(runsService.enqueue).not.toHaveBeenCalled();
    });

    it('should interpolate system prompts when provided', async () => {
      (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
        {
          ...makePrReviewTrigger(),
          prepend_system_prompt: 'You are working on {{repository.full_name}}.',
          append_system_prompt: 'PR URL: {{pull_request.html_url}}',
        },
      ]);

      service.handleWebhook({
        rawBody: validRawBody,
        signatureHeader: validSignature,
        eventType: 'pull_request_review',
        body: payload,
      });
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          appendSystemPrompt: 'PR URL: https://github.com/org/my-repo/pull/42',
        }),
      );
    });

    describe('before hook', () => {
      function makeTriggerWithHook(): GithubTrigger {
        return {
          ...makePrReviewTrigger(),
          before: '/scripts/check.sh',
          prompt: 'PR review context: {{before_output}}',
        };
      }

      it('should not call the hook when trigger.before is unset', async () => {
        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        });
        await flush();

        expect(beforeHookService.run).not.toHaveBeenCalled();
      });

      it('should run the hook with the trigger label and substitute output', async () => {
        (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
          makeTriggerWithHook(),
        ]);
        (beforeHookService.run as jest.Mock).mockResolvedValueOnce({
          proceed: true,
          output: 'gathered context',
        });

        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        });
        await flush();

        expect(beforeHookService.run).toHaveBeenCalledWith(
          '/scripts/check.sh',
          'github trigger "address-review"',
        );
        expect(runsService.enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            prompt: 'PR review context: gathered context',
          }),
        );
      });

      it('should skip the run when the hook returns proceed: false', async () => {
        (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
          makeTriggerWithHook(),
        ]);
        (beforeHookService.run as jest.Mock).mockResolvedValueOnce({
          proceed: false,
          output: '',
        });

        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        });
        await flush();

        expect(beforeHookService.run).toHaveBeenCalled();
        expect(runsService.enqueue).not.toHaveBeenCalled();
      });
    });

    it('should propagate unexpected errors from RunsService unchanged (logged, not thrown)', async () => {
      (runsService.enqueue as jest.Mock).mockRejectedValueOnce(
        new Error('pi crashed'),
      );

      // The error from a single trigger fire is logged-and-swallowed by
      // handleWebhook's per-trigger catch — handleWebhook itself does not throw.
      expect(() =>
        service.handleWebhook({
          rawBody: validRawBody,
          signatureHeader: validSignature,
          eventType: 'pull_request_review',
          body: payload,
        }),
      ).not.toThrow();
      await flush();
    });
  });
});
