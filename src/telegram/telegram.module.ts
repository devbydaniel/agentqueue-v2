import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service.js';
import { OpenaiTtsService } from './openai-tts.service.js';
import { TelegramChatSettingsRepository } from './telegram-chat-settings.repository.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

@Module({
  providers: [
    TelegramService,
    OpenaiTtsService,
    TelegramChatSettingsRepository,
    ExternalSessionRepository,
  ],
  exports: [
    TelegramService,
    OpenaiTtsService,
    TelegramChatSettingsRepository,
    ExternalSessionRepository,
  ],
})
export class TelegramModule {}
