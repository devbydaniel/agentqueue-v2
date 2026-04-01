import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { TriggerConfigService } from './trigger-config.service.js';
import { CronSchedulerService } from './cron-scheduler.service.js';

@Module({
  imports: [RunsModule],
  providers: [TriggerConfigService, CronSchedulerService],
  exports: [TriggerConfigService],
})
export class TriggersModule {}
