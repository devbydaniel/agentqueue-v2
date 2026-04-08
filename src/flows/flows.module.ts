import { Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module.js';
import { RunsModule } from '../runs/runs.module.js';
import { FlowsController } from './flows.controller.js';
import { FlowsService } from './flows.service.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowResolverLoaderService } from './flow-resolver-loader.service.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { FlowRunCompletionListener } from './flow-run-completion.listener.js';
import { FlowRunStartupRecoveryService } from './flow-run-startup-recovery.service.js';

@Module({
  imports: [ConfigModule, RunsModule],
  controllers: [FlowsController],
  providers: [
    FlowsService,
    FlowRunnerService,
    FlowConfigService,
    FlowResolverLoaderService,
    FlowRunRepository,
    FlowAbortTrackerService,
    FlowRunCompletionListener,
    FlowRunStartupRecoveryService,
  ],
})
export class FlowsModule {}
