import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { SlackModule } from './slack.module.js';
import { SlackListenerService } from './slack-listener.service.js';
import { SlackIngestService } from './slack-ingest.service.js';

@Module({
  imports: [RunsModule, SlackModule],
  providers: [SlackIngestService, SlackListenerService],
})
export class SlackListenerModule {}
