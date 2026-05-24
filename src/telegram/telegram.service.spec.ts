/* eslint-disable sonarjs/publicly-writable-directories */
import { TelegramService } from './telegram.service.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { ExternalSessionRepository } from '../runs/external-session.repository.js';
import type { OpenaiTtsService } from './openai-tts.service.js';
import type { TelegramChatSettingsRepository } from './telegram-chat-settings.repository.js';

const TEXT_KEYBOARD = {
  keyboard: [[{ text: '🆕 New Session' }], [{ text: '🔇 Voice: off' }]],
  resize_keyboard: true,
  is_persistent: true,
};

const VOICE_KEYBOARD = {
  keyboard: [[{ text: '🆕 New Session' }], [{ text: '🔊 Voice: on' }]],
  resize_keyboard: true,
  is_persistent: true,
};

describe('TelegramService', () => {
  let service: TelegramService;
  let triggerConfigService: jest.Mocked<TriggerConfigService>;
  let externalSessionRepository: jest.Mocked<ExternalSessionRepository>;
  let ttsService: jest.Mocked<OpenaiTtsService>;
  let chatSettingsRepository: jest.Mocked<TelegramChatSettingsRepository>;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    triggerConfigService = {
      getTelegramTrigger: jest.fn().mockReturnValue({
        name: 'daniel-assistant',
        type: 'telegram',
        bot_name: 'main-bot',
        bot_token: 'bot-token',
        user_id: '456',
        cwd: '/tmp/assistant',
      }),
    } as unknown as jest.Mocked<TriggerConfigService>;

    externalSessionRepository = {
      findBySessionKey: jest.fn().mockResolvedValue({
        provider: 'telegram',
        sessionKey: 'telegram:main-bot:123:main',
        sessionId: 'sess-test-abc',
        botName: 'main-bot',
        chatId: '123',
        messageThreadId: 22,
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    } as unknown as jest.Mocked<ExternalSessionRepository>;

    ttsService = {
      isAvailable: jest.fn().mockReturnValue(true),
      synthesize: jest.fn().mockResolvedValue(Buffer.from('fake-opus')),
    } as unknown as jest.Mocked<OpenaiTtsService>;

    chatSettingsRepository = {
      isVoiceEnabled: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<TelegramChatSettingsRepository>;

    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue('ok'),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    service = new TelegramService(
      triggerConfigService,
      externalSessionRepository,
      ttsService,
      chatSettingsRepository,
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
          reply_markup: TEXT_KEYBOARD,
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

  it('should send a voice note then text when voice mode is enabled', async () => {
    chatSettingsRepository.isVoiceEnabled.mockResolvedValueOnce(true);

    await service.emitRunResponse(
      'daniel-assistant',
      'telegram:main-bot:123:main',
      'Hello there',
    );

    expect(ttsService.synthesize).toHaveBeenCalledWith('Hello there');
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual([
      'https://api.telegram.org/botbot-token/sendVoice',
      'https://api.telegram.org/botbot-token/sendMessage',
    ]);
    // The trailing text message carries the "voice on" keyboard label.
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://api.telegram.org/botbot-token/sendMessage',
      expect.objectContaining({
        body: expect.stringContaining(JSON.stringify(VOICE_KEYBOARD)),
      }),
    );
  });

  it('should fall back to text only when synthesis fails', async () => {
    chatSettingsRepository.isVoiceEnabled.mockResolvedValueOnce(true);
    ttsService.synthesize.mockRejectedValueOnce(new Error('boom'));

    await service.emitRunResponse(
      'daniel-assistant',
      'telegram:main-bot:123:main',
      'Hello there',
    );

    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual(['https://api.telegram.org/botbot-token/sendMessage']);
  });

  it('should never speak errors even when voice mode is enabled', async () => {
    chatSettingsRepository.isVoiceEnabled.mockResolvedValueOnce(true);

    await service.emitRunError(
      'daniel-assistant',
      'telegram:main-bot:123:main',
      'Something broke',
    );

    expect(ttsService.synthesize).not.toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((call) => call[0] as string);
    expect(urls).toEqual(['https://api.telegram.org/botbot-token/sendMessage']);
  });
});
