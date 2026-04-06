import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TriggersModule } from '../triggers/triggers.module.js';
import { ConfigModule } from '../config/config.module.js';
import { WebhooksController } from './api/webhooks.controller.js';
import { LinearWebhookService } from './infrastructure/linear-webhook.service.js';
import { GithubSignatureVerifierService } from './infrastructure/github/github-signature-verifier.service.js';
import { HandleGithubWebhookUseCase } from './application/handle-github-webhook.use-case.js';
import { FireGithubTriggerUseCase } from './application/fire-github-trigger.use-case.js';

@Module({
  imports: [RunsModule, TriggersModule, ConfigModule],
  controllers: [WebhooksController],
  providers: [
    // Infrastructure
    LinearWebhookService,
    GithubSignatureVerifierService,
    // Use cases
    HandleGithubWebhookUseCase,
    FireGithubTriggerUseCase,
  ],
})
export class WebhooksModule {}
