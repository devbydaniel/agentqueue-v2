import { Module } from '@nestjs/common';
import { AgentsModule } from './agents/agents.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { QueueModule } from './queue/queue.module.js';
import { RunsModule } from './runs/runs.module.js';
import { TriggersModule } from './triggers/triggers.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { FlowsModule } from './flows/flows.module.js';
import { TelegramPollerModule } from './telegram/telegram-poller.module.js';
import { SlackListenerModule } from './slack/slack-listener.module.js';
import { MatrixListenerModule } from './matrix/matrix-listener.module.js';

@Module({
  imports: [
    AgentsModule,
    AuthModule,
    ConfigModule,
    DatabaseModule,
    QueueModule,
    HealthModule,
    RunsModule,
    TriggersModule,
    WebhooksModule,
    FlowsModule,
    TelegramPollerModule,
    SlackListenerModule,
    MatrixListenerModule,
  ],
})
export class AppModule {}
