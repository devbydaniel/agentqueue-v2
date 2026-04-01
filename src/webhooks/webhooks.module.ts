import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { ConfigModule } from '../config/config.module.js';
import { LinearWebhookService } from './linear-webhook.service.js';
import { WebhooksController } from './webhooks.controller.js';

@Module({
  imports: [RunsModule, TriggersModule, ConfigModule],
  controllers: [WebhooksController],
  providers: [LinearWebhookService],
})
export class WebhooksModule {}
