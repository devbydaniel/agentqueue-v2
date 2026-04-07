import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { CronSchedulerService } from './cron-scheduler.service.js';
import { BeforeHookService } from './before-hook.service.js';

@Module({
  imports: [RunsModule],
  providers: [CronSchedulerService, BeforeHookService],
  exports: [BeforeHookService],
})
export class TriggersModule {}
