import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { SlackModule } from '../slack/slack.module.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunQueueWorkerService } from './run-queue-worker.service.js';
import { SdkSessionFactory } from './sdk-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import { RunEventRepository } from './run-event.repository.js';
import { RunStartupRecoveryService } from './run-startup-recovery.service.js';
import { RunLifecycleService } from './run-lifecycle.service.js';
import { RunHandlerBuilder } from './run-handler-builder.service.js';
import { RunSourceNotifier } from './run-source-notifier.service.js';

@Module({
  imports: [CallbacksModule, TelegramModule, SlackModule, AgentsModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    RunProcessorService,
    RunQueueWorkerService,
    SdkSessionFactory,
    ActiveSessionTrackerService,
    RunRepository,
    RunCompletionNotifier,
    RunEventRepository,
    RunStartupRecoveryService,
    RunLifecycleService,
    RunHandlerBuilder,
    RunSourceNotifier,
  ],
  exports: [RunsService, RunRepository],
})
export class RunsModule {}
