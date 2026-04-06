import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { FlowsController } from './flows.controller.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRunRepository } from './infrastructure/flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { FlowExecutorService } from './application/flow-executor.service.js';

@Module({
  imports: [RunsModule],
  controllers: [FlowsController],
  providers: [
    FlowConfigService,
    FlowRunRepository,
    FlowAbortTrackerService,
    FlowExecutorService,
  ],
})
export class FlowsModule {}
