import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { WebhooksController } from './webhooks.controller.js';
import { LinearWebhookService } from './linear-webhook.service.js';
import { TriggerConfigService } from '../triggers/trigger-config.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { ExecuteRunUseCase } from '../runs/application/execute-run.use-case.js';
import { ApplicationErrorFilter } from '../common/filters/application-error.filter.js';
import type { LinearTrigger } from '../triggers/trigger-config.interface.js';

describe('WebhooksController', () => {
  let app: INestApplication;
  let executeRunMock: jest.Mock;

  const linearConfig: LinearTrigger = {
    name: 'linear',
    type: 'linear',
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

    const module = await Test.createTestingModule({
      controllers: [WebhooksController],
      providers: [
        LinearWebhookService,
        {
          provide: TriggerConfigService,
          useValue: {
            getLinearTrigger: jest.fn().mockReturnValue(linearConfig),
          },
        },
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn().mockReturnValue('/home/user/dev/my-agent'),
          },
        },
        {
          provide: ExecuteRunUseCase,
          useValue: {
            execute: executeRunMock,
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
      .post('/webhooks/linear/my-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });

  it('should call executeRunUseCase with correct args for created action', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    await request(app.getHttpServer())
      .post('/webhooks/linear/my-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    // Wait for the async fire-and-forget to be called
    await new Promise((r) => setTimeout(r, 50));

    expect(executeRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'my-agent',
        prompt: 'Fix the auth bug',
        additionalHandlers: expect.arrayContaining([
          expect.objectContaining({ name: 'linear' }),
        ]),
      }),
    );
  });

  it('should return 200 for a valid prompted webhook', async () => {
    const promptedPayload = {
      action: 'prompted',
      type: 'AgentSession',
      webhookTimestamp: Date.now(),
      data: {
        id: 'session-123',
        agentActivityBody: 'Also fix the tests',
      },
    };
    const body = JSON.stringify(promptedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/my-agent')
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

  it('should return 404 when linear trigger is not configured', async () => {
    const triggerService = app.get(TriggerConfigService);
    (triggerService.getLinearTrigger as jest.Mock).mockReturnValue(undefined);

    const body = JSON.stringify(validCreatedPayload);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/my-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', 'anything')
      .send(body);

    expect(res.status).toBe(404);
  });

  it('should return 401 for an invalid signature', async () => {
    const body = JSON.stringify(validCreatedPayload);
    const badSig = sign(body, 'wrong-secret');

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/my-agent')
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
      .post('/webhooks/linear/my-agent')
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
      .post('/webhooks/linear/my-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(400);
  });

  it('should return 404 for an unknown agent name', async () => {
    const configService = app.get(AgentfilesConfigService);
    const { RepoNotFoundError } = await import('../config/config.errors.js');
    (configService.resolveRepo as jest.Mock).mockImplementation(() => {
      throw new RepoNotFoundError('unknown-agent');
    });

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/unknown-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    expect(res.status).toBe(404);
  });

  it('should return 200 before the run completes (async execution)', async () => {
    // Make execute take a long time
    executeRunMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 5000)),
    );

    const body = JSON.stringify(validCreatedPayload);
    const sig = sign(body);

    const res = await request(app.getHttpServer())
      .post('/webhooks/linear/my-agent')
      .set('Content-Type', 'application/json')
      .set('linear-signature', sig)
      .send(body);

    // Controller returns immediately without waiting for the run
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: true });
  });
});
