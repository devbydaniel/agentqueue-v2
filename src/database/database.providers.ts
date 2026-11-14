import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import pg from 'pg';
import { AppConfigService } from '../config/app-config.service.js';
import { PG_POOL } from './database.tokens.js';

export const databaseProviders: Provider[] = [
  {
    provide: PG_POOL,
    useFactory: (config: AppConfigService): pg.Pool => {
      const pool = new pg.Pool({ connectionString: config.databaseUrl });
      // An idle client that loses its connection emits on the pool, and an
      // unhandled error crashes the process. The pool drops the client and
      // connects a new one on the next query.
      const logger = new Logger('PgPool');
      pool.on('error', (error) => {
        logger.error('Idle database client error', { error });
      });
      return pool;
    },
    inject: [AppConfigService],
  },
];

@Injectable()
export class DatabaseShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseShutdownService.name);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    this.logger.log('Closing PG pool');
    await this.pool.end();
    this.logger.log('PG pool closed');
  }
}
