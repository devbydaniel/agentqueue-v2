import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunQueueWorkerService } from './run-queue-worker.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { LinearSessionRepository } from './linear-session.repository.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    RunProcessorService,
    RunQueueWorkerService,
    PiSessionFactory,
    LinearSessionRepository,
    ActiveSessionTrackerService,
    RunRepository,
    RunCompletionNotifier,
  ],
  exports: [RunsService, RunRepository],
})
export class RunsModule {}
