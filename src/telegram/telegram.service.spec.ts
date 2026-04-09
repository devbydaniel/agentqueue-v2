/* eslint-disable sonarjs/publicly-writable-directories */
import { TelegramService } from './telegram.service.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { ExternalSessionRepository } from '../runs/external-session.repository.js';

describe('TelegramService', () => {
  let service: TelegramService;
  let triggerConfigService: jest.Mocked<TriggerConfigService>;
  let externalSessionRepository: jest.Mocked<ExternalSessionRepository>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    triggerConfigService = {
      getTelegramTrigger: jest.fn().mockReturnValue({
        name: 'daniel-assistant',
        type: 'telegram',
        bot_name: 'main-bot',
        bot_token: 'bot-token',
        webhook_secret: 'secret',
        user_id: '456',
        cwd: '/tmp/assistant',
      }),
    } as unknown as jest.Mocked<TriggerConfigService>;

    externalSessionRepository = {
      findBySessionKey: jest.fn().mockResolvedValue({
        provider: 'telegram',
        sessionKey: 'telegram:main-bot:123:main',
        filePath: '/sessions/test.jsonl',
        botName: 'main-bot',
        chatId: '123',
        messageThreadId: 22,
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    } as unknown as jest.Mocked<ExternalSessionRepository>;

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('ok'),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new TelegramService(
      triggerConfigService,
      externalSessionRepository,
    );
  });

  it('should send a completion message to the stored chat/thread', async () => {
    await service.emitRunResponse(
      'daniel-assistant',
      'telegram:main-bot:123:main',
      'Completed',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botbot-token/sendMessage',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          chat_id: '123',
          text: 'Completed',
          message_thread_id: 22,
        }),
      }),
    );
  });

  it('should skip replies when the external session no longer exists', async () => {
    (
      externalSessionRepository.findBySessionKey as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.emitRunResponse(
      'daniel-assistant',
      'telegram:main-bot:123:main',
      'Completed',
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('should split long direct messages into multiple Telegram calls', async () => {
    const longText = `A${'\nB'.repeat(4500)}`;

    await service.sendDirectMessage({
      botToken: 'bot-token',
      chatId: '123',
      text: longText,
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
