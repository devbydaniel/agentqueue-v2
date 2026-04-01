import { Module } from '@nestjs/common';
import { HealthModule } from './health/health.module.js';
import { ConfigModule } from './config/config.module.js';
import { RunsModule } from './runs/runs.module.js';

@Module({
  imports: [ConfigModule, HealthModule, RunsModule],
})
export class AppModule {}
