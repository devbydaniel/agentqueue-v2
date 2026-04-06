import { Test } from '@nestjs/testing';
import { HandleGithubWebhookUseCase } from './handle-github-webhook.use-case.js';
import { FireGithubTriggerUseCase } from './fire-github-trigger.use-case.js';
import { TriggerConfigService } from '../../triggers/trigger-config.service.js';
import type { GithubTrigger } from '../../triggers/trigger-config.interface.js';

const prReviewTrigger: GithubTrigger = {
  name: 'address-review',
  type: 'github',
  events: ['pull_request_review'],
  target: '{{repository.name}}',
  prompt: 'Address review on PR #{{pull_request.number}}.',
  filters: [
    { field: 'action', equals: 'submitted' },
    { field: 'review.state', in: ['changes_requested', 'commented'] },
  ],
};

const payload = {
  action: 'submitted',
  repository: { name: 'my-repo', full_name: 'org/my-repo' },
  pull_request: { number: 42 },
  review: { state: 'changes_requested', user: { login: 'alice' } },
};

/** Flush pending microtasks so async fire-and-forget chains complete. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('HandleGithubWebhookUseCase', () => {
  let useCase: HandleGithubWebhookUseCase;
  let triggerConfigService: TriggerConfigService;
  let fireGithubTriggerUseCase: FireGithubTriggerUseCase;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        HandleGithubWebhookUseCase,
        {
          provide: TriggerConfigService,
          useValue: { getGithubTriggers: jest.fn(() => []) },
        },
        {
          provide: FireGithubTriggerUseCase,
          useValue: { execute: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    useCase = module.get(HandleGithubWebhookUseCase);
    triggerConfigService = module.get(TriggerConfigService);
    fireGithubTriggerUseCase = module.get(FireGithubTriggerUseCase);
  });

  it('should match a trigger and fire it', async () => {
    (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
      prReviewTrigger,
    ]);

    const result = await useCase.execute({
      eventType: 'pull_request_review',
      payload,
    });
    await flush();

    expect(result.triggered).toBe(1);
    expect(fireGithubTriggerUseCase.execute).toHaveBeenCalledWith({
      trigger: prReviewTrigger,
      payload,
    });
  });

  it('should not match when the event type does not match', async () => {
    (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
      prReviewTrigger,
    ]);

    const result = await useCase.execute({ eventType: 'issues', payload });

    expect(result.triggered).toBe(0);
    expect(fireGithubTriggerUseCase.execute).not.toHaveBeenCalled();
  });

  it('should not match when filters do not pass', async () => {
    (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
      prReviewTrigger,
    ]);

    const approvedPayload = {
      ...payload,
      review: { ...payload.review, state: 'approved' },
    };

    const result = await useCase.execute({
      eventType: 'pull_request_review',
      payload: approvedPayload,
    });

    expect(result.triggered).toBe(0);
    expect(fireGithubTriggerUseCase.execute).not.toHaveBeenCalled();
  });

  it('should match and fire multiple triggers', async () => {
    const secondTrigger: GithubTrigger = {
      name: 'log-review',
      type: 'github',
      events: ['pull_request_review'],
      target: '{{repository.name}}',
      prompt: 'Log review.',
    };
    (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
      prReviewTrigger,
      secondTrigger,
    ]);

    const result = await useCase.execute({
      eventType: 'pull_request_review',
      payload,
    });
    await flush();

    expect(result.triggered).toBe(2);
    expect(fireGithubTriggerUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('should swallow errors from individual fire calls (fire-and-forget)', async () => {
    (triggerConfigService.getGithubTriggers as jest.Mock).mockReturnValue([
      prReviewTrigger,
    ]);
    (fireGithubTriggerUseCase.execute as jest.Mock).mockRejectedValueOnce(
      new Error('boom'),
    );

    const result = await useCase.execute({
      eventType: 'pull_request_review',
      payload,
    });
    // Even though fire failed, we still return the matched count
    expect(result.triggered).toBe(1);
    await flush();
  });
});
