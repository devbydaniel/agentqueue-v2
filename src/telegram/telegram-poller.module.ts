import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TelegramModule } from './telegram.module.js';
import { TelegramIngestService } from './telegram-ingest.service.js';
import { TelegramMediaService } from './telegram-media.service.js';
import { VoxtralTranscriptionService } from './voxtral-transcription.service.js';
import { TelegramBatcherService } from './telegram-batcher.service.js';
import { TelegramPollerService } from './telegram-poller.service.js';

@Module({
  imports: [RunsModule, TelegramModule],
  providers: [
    TelegramIngestService,
    TelegramMediaService,
    VoxtralTranscriptionService,
    TelegramBatcherService,
    TelegramPollerService,
  ],
})
export class TelegramPollerModule {}
