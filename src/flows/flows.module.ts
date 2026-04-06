import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { FlowsController } from './api/flows.controller.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRunRepository } from './infrastructure/flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { StartFlowUseCase } from './application/start-flow.use-case.js';
import { AbortFlowUseCase } from './application/abort-flow.use-case.js';
import { ListFlowsUseCase } from './application/list-flows.use-case.js';
import { ListFlowRunsUseCase } from './application/list-flow-runs.use-case.js';
import { GetFlowRunUseCase } from './application/get-flow-run.use-case.js';

@Module({
  imports: [RunsModule],
  controllers: [FlowsController],
  providers: [
    // Infrastructure
    FlowConfigService,
    FlowRunRepository,
    FlowAbortTrackerService,
    // Lifecycle
    FlowRunnerService,
    // Use cases
    StartFlowUseCase,
    AbortFlowUseCase,
    ListFlowsUseCase,
    ListFlowRunsUseCase,
    GetFlowRunUseCase,
  ],
})
export class FlowsModule {}
