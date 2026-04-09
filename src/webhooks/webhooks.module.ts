import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { ConfigModule } from '../config/config.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { WebhooksController } from './webhooks.controller.js';
import { LinearWebhooksService } from './linear-webhooks.service.js';
import { GithubWebhooksService } from './github-webhooks.service.js';
import { LinearWebhookParserService } from './linear-webhook-parser.service.js';
import { GithubSignatureVerifierService } from './github-signature-verifier.service.js';
import { TelegramWebhooksService } from './telegram-webhooks.service.js';

@Module({
  imports: [RunsModule, TriggersModule, ConfigModule, TelegramModule],
  controllers: [WebhooksController],
  providers: [
    LinearWebhooksService,
    GithubWebhooksService,
    TelegramWebhooksService,
    LinearWebhookParserService,
    GithubSignatureVerifierService,
  ],
})
export class WebhooksModule {}
