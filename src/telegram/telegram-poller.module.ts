import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { SpeechModule } from '../speech/speech.module.js';
import { TelegramModule } from './telegram.module.js';
import { TelegramIngestService } from './telegram-ingest.service.js';
import { TelegramMediaService } from './telegram-media.service.js';
import { TelegramBatcherService } from './telegram-batcher.service.js';
import { TelegramPollerService } from './telegram-poller.service.js';

@Module({
  imports: [RunsModule, SpeechModule, TelegramModule],
  providers: [
    TelegramIngestService,
    TelegramMediaService,
    TelegramBatcherService,
    TelegramPollerService,
  ],
})
export class TelegramPollerModule {}
