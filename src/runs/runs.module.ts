import { Module } from '@nestjs/common';
import { CallbacksModule } from '../callbacks/callbacks.module.js';
import { RunsController } from './runs.controller.js';
import { ExecuteRunUseCase } from './application/execute-run.use-case.js';

@Module({
  imports: [CallbacksModule],
  controllers: [RunsController],
  providers: [ExecuteRunUseCase],
  exports: [ExecuteRunUseCase],
})
export class RunsModule {}
