import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './runs.controller.js';
import { ExecuteRunUseCase } from './application/execute-run.use-case.js';
import { LinearSessionRepository } from './infrastructure/linear-session.repository.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [
    LinearSessionRepository,
    ActiveSessionTrackerService,
    ExecuteRunUseCase,
  ],
  exports: [ExecuteRunUseCase],
})
export class RunsModule {}
