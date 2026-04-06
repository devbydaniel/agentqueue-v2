import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './api/runs.controller.js';
import { ExecuteRunUseCase } from './application/execute-run.use-case.js';
import { LinearSessionRepository } from './infrastructure/linear-session.repository.js';
import { ActiveSessionTrackerService } from './application/active-session-tracker.service.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [
    // Infrastructure
    LinearSessionRepository,
    // Application services
    ActiveSessionTrackerService,
    // Use cases
    ExecuteRunUseCase,
  ],
  exports: [ExecuteRunUseCase],
})
export class RunsModule {}
