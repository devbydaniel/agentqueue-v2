import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

@Module({
  providers: [TelegramService, ExternalSessionRepository],
  exports: [TelegramService, ExternalSessionRepository],
})
export class TelegramModule {}
