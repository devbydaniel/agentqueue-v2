import { Module } from '@nestjs/common';
import { SpeechModule } from '../speech/speech.module.js';
import { TelegramService } from './telegram.service.js';
import { TelegramChatSettingsRepository } from './telegram-chat-settings.repository.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

@Module({
  imports: [SpeechModule],
  providers: [
    TelegramService,
    TelegramChatSettingsRepository,
    ExternalSessionRepository,
  ],
  exports: [
    TelegramService,
    TelegramChatSettingsRepository,
    ExternalSessionRepository,
  ],
})
export class TelegramModule {}
