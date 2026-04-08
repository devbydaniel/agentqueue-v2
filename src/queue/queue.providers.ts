import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { AppConfigService } from '../config/app-config.service.js';
import { BOSS } from './queue.tokens.js';

// pg-boss manages its own internal connection pool (separate from PG_POOL).
// This is intentional — pg-boss requires full control over its connections.
export const bossProvider: Provider = {
  provide: BOSS,
  useFactory: (config: AppConfigService): PgBoss => {
    return new PgBoss({
      connectionString: config.databaseUrl,
    });
  },
  inject: [AppConfigService],
};

@Injectable()
export class BossLifecycleService
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly logger = new Logger(BossLifecycleService.name);

  constructor(@Inject(BOSS) private readonly boss: PgBoss) {}

  async onModuleInit(): Promise<void> {
    this.logger.log('Starting pg-boss');
    await this.boss.start();
    this.logger.log('pg-boss started');
  }

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Stopping pg-boss gracefully');
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    this.logger.log('pg-boss stopped');
  }
}
