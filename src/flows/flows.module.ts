import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { FlowsController } from './flows.controller.js';
import { FlowsService } from './flows.service.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowResolverLoaderService } from './flow-resolver-loader.service.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';

@Module({
  imports: [RunsModule],
  controllers: [FlowsController],
  providers: [
    FlowsService,
    FlowRunnerService,
    FlowConfigService,
    FlowResolverLoaderService,
    FlowRunRepository,
    FlowAbortTrackerService,
  ],
})
export class FlowsModule {}
