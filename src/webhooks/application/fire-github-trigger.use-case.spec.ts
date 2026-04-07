import { Test } from '@nestjs/testing';
import { FireGithubTriggerUseCase } from './fire-github-trigger.use-case.js';
import { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import { RunsService } from '../../runs/runs.service.js';
import { BeforeHookService } from '../../triggers/before-hook.service.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';
import { UnexpectedWebhookError } from './webhooks.errors.js';

const baseTrigger: GithubTrigger = {
  name: 'address-review',
  type: 'github',
  events: ['pull_request_review'],
  target: '{{repository.name}}',
  prompt:
    'Address review on PR #{{pull_request.number}} by {{review.user.login}}.',
  filters: [],
};

const basePayload = {
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

describe('FireGithubTriggerUseCase', () => {
  let useCase: FireGithubTriggerUseCase;
  let agentfilesConfigService: AgentfilesConfigService;
  let runsService: RunsService;
  let beforeHookService: BeforeHookService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        FireGithubTriggerUseCase,
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn((name: string) => `/repos/${name}`),
          },
        },
        {
          provide: RunsService,
          useValue: { execute: jest.fn().mockResolvedValue({ success: true }) },
        },
        {
          provide: BeforeHookService,
          useValue: {
            run: jest.fn().mockResolvedValue({ proceed: true, output: '' }),
          },
        },
      ],
    }).compile();

    useCase = module.get(FireGithubTriggerUseCase);
    agentfilesConfigService = module.get(AgentfilesConfigService);
    runsService = module.get(RunsService);
    beforeHookService = module.get(BeforeHookService);
  });

  it('should interpolate the target and prompt and dispatch the run', async () => {
    await useCase.execute({ trigger: baseTrigger, payload: basePayload });

    expect(runsService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'my-repo',
        prompt: 'Address review on PR #42 by alice.',
      }),
    );
  });

  it('should skip when resolved repo is not configured', async () => {
    (agentfilesConfigService.resolveRepo as jest.Mock).mockImplementation(
      () => {
        throw new Error('not found');
      },
    );

    await useCase.execute({ trigger: baseTrigger, payload: basePayload });

    expect(runsService.execute).not.toHaveBeenCalled();
  });

  it('should skip when prompt exceeds the max length', async () => {
    const huge = 'x'.repeat(60_000);
    const trigger: GithubTrigger = { ...baseTrigger, prompt: huge };

    await useCase.execute({ trigger, payload: basePayload });

    expect(runsService.execute).not.toHaveBeenCalled();
  });

  it('should interpolate system prompts when provided', async () => {
    const trigger: GithubTrigger = {
      ...baseTrigger,
      prepend_system_prompt: 'You are working on {{repository.full_name}}.',
      append_system_prompt: 'PR URL: {{pull_request.html_url}}',
    };

    await useCase.execute({ trigger, payload: basePayload });

    expect(runsService.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        prependSystemPrompt: 'You are working on org/my-repo.',
        appendSystemPrompt: 'PR URL: https://github.com/org/my-repo/pull/42',
      }),
    );
  });

  describe('before hook', () => {
    const triggerWithHook: GithubTrigger = {
      ...baseTrigger,
      before: '/scripts/check.sh',
      prompt: 'PR review context: {{before_output}}',
    };

    it('should not call the hook when trigger.before is unset', async () => {
      await useCase.execute({ trigger: baseTrigger, payload: basePayload });

      expect(beforeHookService.run).not.toHaveBeenCalled();
    });

    it('should run the hook with the trigger label and substitute output', async () => {
      (beforeHookService.run as jest.Mock).mockResolvedValueOnce({
        proceed: true,
        output: 'gathered context',
      });

      await useCase.execute({ trigger: triggerWithHook, payload: basePayload });

      expect(beforeHookService.run).toHaveBeenCalledWith(
        '/scripts/check.sh',
        'github trigger "address-review"',
      );
      expect(runsService.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'PR review context: gathered context',
        }),
      );
    });

    it('should skip the run when the hook returns proceed: false', async () => {
      (beforeHookService.run as jest.Mock).mockResolvedValueOnce({
        proceed: false,
        output: '',
      });

      await useCase.execute({ trigger: triggerWithHook, payload: basePayload });

      expect(beforeHookService.run).toHaveBeenCalled();
      expect(runsService.execute).not.toHaveBeenCalled();
    });
  });

  it('should wrap unexpected RunsService errors in UnexpectedWebhookError', async () => {
    (runsService.execute as jest.Mock).mockRejectedValueOnce(
      new Error('pi crashed'),
    );

    await expect(
      useCase.execute({ trigger: baseTrigger, payload: basePayload }),
    ).rejects.toThrow(UnexpectedWebhookError);
  });
});
