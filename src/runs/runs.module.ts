import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './runs.controller.js';
import { ExecuteRunUseCase } from './application/execute-run.use-case.js';
import { SessionRegistryService } from './session-registry.service.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [SessionRegistryService, ExecuteRunUseCase],
  exports: [ExecuteRunUseCase],
})
export class RunsModule {}
