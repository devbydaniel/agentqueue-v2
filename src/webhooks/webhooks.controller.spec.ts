import { WebhooksController } from './webhooks.controller.js';
import type { LinearWebhooksService } from './linear-webhooks.service.js';
import type { GithubWebhooksService } from './github-webhooks.service.js';
import type { TelegramWebhooksService } from './telegram-webhooks.service.js';

describe('WebhooksController', () => {
  let controller: WebhooksController;
  let linearWebhooksService: jest.Mocked<LinearWebhooksService>;
  let githubWebhooksService: jest.Mocked<GithubWebhooksService>;
  let telegramWebhooksService: jest.Mocked<TelegramWebhooksService>;

  beforeEach(() => {
    linearWebhooksService = {
      handleWebhook: jest.fn(),
    } as unknown as jest.Mocked<LinearWebhooksService>;

    githubWebhooksService = {
      handleWebhook: jest.fn().mockReturnValue({ triggered: 1 }),
    } as unknown as jest.Mocked<GithubWebhooksService>;

    telegramWebhooksService = {
      handleWebhook: jest
        .fn()
        .mockResolvedValue({ accepted: true, handled: true }),
    } as unknown as jest.Mocked<TelegramWebhooksService>;

    controller = new WebhooksController(
      linearWebhooksService,
      githubWebhooksService,
      telegramWebhooksService,
    );
  });

  it('should return ok for Linear webhook verification', () => {
    expect(controller.verifyLinearWebhook()).toEqual({ ok: true });
  });

  it('should delegate Linear webhook payloads to LinearWebhooksService', () => {
    const req = {
      rawBody: Buffer.from('{"hello":"world"}'),
      headers: {
        'linear-signature': 'sig',
        'linear-timestamp': '123',
      },
      body: { hello: 'world' },
    };

    const result = controller.handleLinearWebhook('coding-agent', req);

    expect(result).toEqual({ accepted: true });
    expect(linearWebhooksService.handleWebhook).toHaveBeenCalledWith({
      agentName: 'coding-agent',
      rawBody: req.rawBody,
      signatureHeader: 'sig',
      timestampHeader: '123',
      body: { hello: 'world' },
    });
  });

  it('should delegate GitHub webhooks and return the trigger count', () => {
    const req = {
      rawBody: Buffer.from('{"action":"opened"}'),
      headers: {
        'x-hub-signature-256': 'sha256=abc',
        'x-github-event': 'issues',
      },
      body: { action: 'opened' },
    };

    const result = controller.handleGithubWebhook(req);

    expect(result).toEqual({ accepted: true, triggered: 1 });
    expect(githubWebhooksService.handleWebhook).toHaveBeenCalledWith({
      rawBody: req.rawBody,
      signatureHeader: 'sha256=abc',
      eventType: 'issues',
      body: { action: 'opened' },
    });
  });

  it('should delegate Telegram webhooks and return the handler result', async () => {
    const req = {
      headers: {
        'x-telegram-bot-api-secret-token': 'secret',
      },
      body: {
        message: {
          message_id: 10,
          text: 'hello',
          chat: { id: 123 },
          from: { id: 456 },
        },
      },
    };

    const result = await controller.handleTelegramWebhook('main-bot', req);

    expect(result).toEqual({ accepted: true, handled: true });
    expect(telegramWebhooksService.handleWebhook).toHaveBeenCalledWith({
      botName: 'main-bot',
      secretTokenHeader: 'secret',
      body: req.body,
    });
  });
});
