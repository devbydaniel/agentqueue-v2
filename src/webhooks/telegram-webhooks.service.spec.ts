import { UnauthorizedException } from '@nestjs/common';
/* eslint-disable sonarjs/publicly-writable-directories */
/* eslint-disable security/detect-non-literal-fs-filename */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TelegramWebhooksService } from './telegram-webhooks.service.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { RunsService } from '../runs/runs.service.js';
import type { ExternalSessionRepository } from '../runs/external-session.repository.js';
import type { TelegramService } from '../telegram/telegram.service.js';

describe('TelegramWebhooksService', () => {
  let service: TelegramWebhooksService;
  let triggerConfigService: jest.Mocked<TriggerConfigService>;
  let runsService: jest.Mocked<RunsService>;
  let externalSessionRepository: jest.Mocked<ExternalSessionRepository>;
  let telegramService: jest.Mocked<TelegramService>;
  let tmpDir: string;

  const telegramTrigger = {
    name: 'daniel-assistant',
    type: 'telegram' as const,
    bot_name: 'main-bot',
    bot_token: 'bot-token',
    webhook_secret: 'webhook-secret',
    user_id: '456',
    cwd: '/tmp/assistant',
    prepend_system_prompt: 'Reply to {{userId}} on {{cwd}}',
    append_system_prompt: 'Chat {{chatId}}',
    timeout_ms: 1234,
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-webhooks-test-'));
    fs.mkdirSync(path.join(tmpDir, 'assistant'));

    triggerConfigService = {
      getTelegramBotConfig: jest.fn().mockReturnValue({
        botName: 'main-bot',
        botToken: 'bot-token',
        webhookSecret: 'webhook-secret',
      }),
      getTelegramTriggersForBot: jest.fn().mockReturnValue([telegramTrigger]),
    } as unknown as jest.Mocked<TriggerConfigService>;

    runsService = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ runId: 'run-1', status: 'waiting' }),
      abortSession: jest.fn().mockReturnValue(true),
    } as unknown as jest.Mocked<RunsService>;

    externalSessionRepository = {
      findBySessionKey: jest.fn().mockResolvedValue(null),
      upsertSession: jest.fn().mockResolvedValue(undefined),
      deleteBySessionKey: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ExternalSessionRepository>;

    telegramService = {
      sendAcknowledgement: jest.fn().mockResolvedValue(undefined),
      sendDirectMessage: jest.fn().mockResolvedValue(undefined),
      emitRunError: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TelegramService>;

    service = new TelegramWebhooksService(
      triggerConfigService,
      runsService,
      externalSessionRepository,
      telegramService,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should reject invalid Telegram webhook secrets', async () => {
    await expect(
      service.handleWebhook({
        botName: 'main-bot',
        secretTokenHeader: 'wrong',
        body: {},
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should ignore messages without a matching sender route', async () => {
    triggerConfigService.getTelegramTriggersForBot.mockReturnValue([
      { ...telegramTrigger, user_id: '999' },
    ]);

    const result = await service.handleWebhook({
      botName: 'main-bot',
      secretTokenHeader: 'webhook-secret',
      body: {
        message: {
          message_id: 10,
          text: 'hello',
          chat: { id: 123 },
          from: { id: 456 },
        },
      },
    });

    expect(result).toEqual({ accepted: true, handled: false });
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('should enqueue Telegram runs and acknowledge accepted messages', async () => {
    triggerConfigService.getTelegramTriggersForBot.mockReturnValue([
      { ...telegramTrigger, cwd: path.join(tmpDir, 'assistant') },
    ]);

    const result = await service.handleWebhook({
      botName: 'main-bot',
      secretTokenHeader: 'webhook-secret',
      body: {
        message: {
          message_id: 10,
          message_thread_id: 22,
          text: 'hello',
          chat: { id: 123 },
          from: { id: 456 },
        },
      },
    });

    expect(result).toEqual({ accepted: true, handled: true });
    expect(externalSessionRepository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'telegram',
        sessionKey: 'telegram:main-bot:123:22',
        sessionId: null,
        botName: 'main-bot',
        chatId: '123',
        messageThreadId: 22,
      }),
    );
    expect(runsService.enqueue).toHaveBeenCalledWith({
      source: 'telegram',
      triggerName: 'daniel-assistant',
      cwd: path.join(tmpDir, 'assistant'),
      prompt: 'hello',
      externalSessionId: 'telegram:main-bot:123:22',
      appendSystemPrompt: 'Chat 123',
      timeoutMs: 1234,
    });
    expect(telegramService.sendAcknowledgement).toHaveBeenCalledWith({
      botToken: 'bot-token',
      chatId: '123',
      messageThreadId: 22,
      replyToMessageId: 10,
    });
  });

  it('should reset the session and abort the active run for /reset', async () => {
    triggerConfigService.getTelegramTriggersForBot.mockReturnValue([
      { ...telegramTrigger, cwd: path.join(tmpDir, 'assistant') },
    ]);

    const result = await service.handleWebhook({
      botName: 'main-bot',
      secretTokenHeader: 'webhook-secret',
      body: {
        message: {
          message_id: 10,
          text: '/reset',
          chat: { id: 123 },
          from: { id: 456 },
        },
      },
    });

    expect(result).toEqual({ accepted: true, handled: true });
    expect(externalSessionRepository.deleteBySessionKey).toHaveBeenCalledWith(
      'telegram:main-bot:123:main',
    );
    expect(runsService.abortSession).toHaveBeenCalledWith(
      'telegram:main-bot:123:main',
    );
    expect(telegramService.sendDirectMessage).toHaveBeenCalledWith({
      botToken: 'bot-token',
      chatId: '123',
      text: 'Session reset. Send a new message to start fresh.',
      messageThreadId: undefined,
      replyToMessageId: 10,
    });
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('should clear stale sessions after one hour before reusing the key', async () => {
    triggerConfigService.getTelegramTriggersForBot.mockReturnValue([
      { ...telegramTrigger, cwd: path.join(tmpDir, 'assistant') },
    ]);

    externalSessionRepository.findBySessionKey.mockResolvedValueOnce({
      provider: 'telegram',
      sessionKey: 'telegram:main-bot:123:main',
      sessionId: 'sess-old-789',
      botName: 'main-bot',
      chatId: '123',
      messageThreadId: null,
      lastActivityAt: new Date(Date.now() - 61 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await service.handleWebhook({
      botName: 'main-bot',
      secretTokenHeader: 'webhook-secret',
      body: {
        message: {
          message_id: 10,
          text: 'fresh start',
          chat: { id: 123 },
          from: { id: 456 },
        },
      },
    });

    expect(externalSessionRepository.deleteBySessionKey).toHaveBeenCalledWith(
      'telegram:main-bot:123:main',
    );
    expect(runsService.abortSession).toHaveBeenCalledWith(
      'telegram:main-bot:123:main',
    );
    expect(externalSessionRepository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'telegram:main-bot:123:main',
        sessionId: null,
      }),
    );
  });
});
