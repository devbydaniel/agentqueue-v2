import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';
import { LinearSessionRepository } from './linear-session.repository.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [
    RunsService,
    LinearSessionRepository,
    ActiveSessionTrackerService,
  ],
  exports: [RunsService],
})
export class RunsModule {}
