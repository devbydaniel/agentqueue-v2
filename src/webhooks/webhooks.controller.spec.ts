import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { WebhooksController } from './webhooks.controller.js';
import { LinearWebhooksService } from './linear-webhooks.service.js';
import { GithubWebhooksService } from './github-webhooks.service.js';
import { LinearWebhookParserService } from './linear-webhook-parser.service.js';
import { GithubSignatureVerifierService } from './github-signature-verifier.service.js';
import { TriggerConfigService } from '../triggers/trigger-config.service.js';
import { BeforeHookService } from '../triggers/before-hook.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { RunsService } from '../runs/runs.service.js';
import { ApplicationErrorFilter } from '../common/filters/application-error.filter.js';
import type { LinearTrigger } from '../triggers/trigger-config.interface.js';

describe('WebhooksController', () => {
  let app: INestApplication;
  let executeRunMock: jest.Mock;
  let getLinearTriggerMock: jest.Mock;

  const linearConfig: LinearTrigger = {
    name: 'coding-agent',
    type: 'linear',
    target: 'my-repo',
    signing_secret: 'test-signing-secret',
    api_key: 'test-api-key',
  };

  const validCreatedPayload = {
    action: 'created',
    type: 'AgentSession',
    webhookTimestamp: Date.now(),
    data: {
      id: 'session-123',
      promptContext: 'Fix the auth bug',
      issueId: 'issue-456',
    },
  };

  function sign(body: string, secret = linearConfig.signing_secret): string {
    return createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  }

  beforeEach(async () => {
    executeRunMock = jest.fn().mockResolvedValue({ success: true });
    getLinearTriggerMock = jest.fn().mockImplementation((name: string) => {
      if (name === 'coding-agent') return linearConfig;
      return undefined;
    });

    const module = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        // Real services under test
        LinearWebhooksService,
        GithubWebhooksService,
        LinearWebhookParserService,
        // Mocked dependencies
        {
          provide: GithubSignatureVerifierService,
          useValue: { verify: jest.fn() },
        },
        {
          provide: TriggerConfigService,
          useValue: {
            getLinearTrigger: getLinearTriggerMock,
            getGithubTriggers: jest.fn(() => []),
          },
        },
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn().mockReturnValue('/home/user/dev/my-repo'),
          },
        },
        {
          provide: RunsService,
          useValue: {
            execute: executeRunMock,
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

    app = module.createNestApplication({ rawBody: true });
    app.useGlobalFilters(new ApplicationErrorFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return 200 for a valid created webhook', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });

  it('should resolve repo from target, not from route param', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    // Wait for the async fire-and-forget to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(executeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'my-repo', // target, not "coding-agent"
        prompt: 'Fix the auth bug',
        additionalHandlers: expect.arrayContaining([
          expect.objectContaining({ name: 'linear' }),
        ]),
      }),
    );
  });

  it('should look up linear config by agent name from route', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(getLinearTriggerMock).toHaveBeenCalledWith('coding-agent');
  });

  it('should return 200 for a valid prompted webhook', async () => {
    const promptedPayload = {
      action: 'prompted',
      type: 'AgentSession',
      webhookTimestamp: Date.now(),
      data: {
        id: 'session-123',
      },
      agentActivity: {
        content: {
          type: 'prompt',
          body: 'Also fix the tests',
        },
      },
    };
    const body = JSON.stringify(promptedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });

    await new Promise((r) => setTimeout(r, 50));

    expect(executeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Also fix the tests',
      }),
    );
  });

  it('should return 404 when no linear trigger matches the agent name', async () => {
    const body = JSON.stringify(validCreatedPayload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/unknown-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', 'anything')
      .send(body);

    expect(res.status).toBe(404);
    expect(getLinearTriggerMock).toHaveBeenCalledWith('unknown-agent');
  });

  it('should return 401 for an invalid signature', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const badSig = sign(body, 'wrong-secret');

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', badSig)
      .send(body);

    expect(res.status).toBe(401);
  });

  it('should return 401 for a stale timestamp', async () => {
    const stalePayload = {
      ...validCreatedPayload,
      webhookTimestamp: Date.now() - 120_000,
    };
    const body = JSON.stringify(stalePayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(401);
  });

  it('should return 400 for a malformed payload', async () => {
    const badPayload = {
      action: 'unknown_action',
      type: 'AgentSession',
      webhookTimestamp: Date.now(),
      data: { id: 'x' },
    };
    const body = JSON.stringify(badPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('should return 404 when target repo is not found in agentfiles', async () => {
    const configService = app.get(AgentfilesConfigService);
    const { RepoNotFoundError } = await import('../config/config.errors.js');
    (configService.resolveRepo as jest.Mock).mockImplementation(() => {
      throw new RepoNotFoundError('my-repo');
    });

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(404);
  });

  it('should use per-agent signing secret for verification', async () => {
    const secondConfig: LinearTrigger = {
      name: 'review-agent',
      type: 'linear',
      target: 'other-repo',
      signing_secret: 'different-secret',
      api_key: 'other-key',
    };
    getLinearTriggerMock.mockImplementation((name: string) => {
      if (name === 'coding-agent') return linearConfig;
      if (name === 'review-agent') return secondConfig;
      return undefined;
    });

    // Sign with the second agent's secret
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body, 'different-secret');

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/review-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });

  it('should return 200 before the run completes (async execution)', async () => {
    // Make execute take a long time
    executeRunMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    // Controller returns immediately without waiting for the run
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });

  it('should pass interpolated prepend_system_prompt to execute', async () => {
    const configWithPrepend: LinearTrigger = {
      ...linearConfig,
      prepend_system_prompt:
        'You are working on issue {{issueId}} (session {{agentSessionId}}).',
    };
    getLinearTriggerMock.mockReturnValue(configWithPrepend);

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    await new Promise((r) => setTimeout(r, 50));

    expect(executeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prependSystemPrompt:
          'You are working on issue issue-456 (session session-123).',
      }),
    );
  });

  it('should pass interpolated append_system_prompt to execute', async () => {
    const configWithAppend: LinearTrigger = {
      ...linearConfig,
      append_system_prompt: 'Agent: {{agentName}}, target: {{target}}.',
    };
    getLinearTriggerMock.mockReturnValue(configWithAppend);

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    await new Promise((r) => setTimeout(r, 50));

    expect(executeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appendSystemPrompt: 'Agent: coding-agent, target: my-repo.',
      }),
    );
  });

  it('should not pass system prompt fields when trigger has no templates', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/coding-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    await new Promise((r) => setTimeout(r, 50));

    const call = executeRunMock.mock.calls[0][0] as Record<string, unknown>;
    expect(call['prependSystemPrompt']).toBeUndefined();
    expect(call['appendSystemPrompt']).toBeUndefined();
  });
});
