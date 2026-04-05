import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { FlowsController } from './flows.controller.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRegistryService } from './flow-registry.service.js';
import { FlowExecutorService } from './application/flow-executor.service.js';

@Module({
  imports: [RunsModule],
  controllers: [FlowsController],
  providers: [FlowConfigService, FlowRegistryService, FlowExecutorService],
})
export class FlowsModule {}
