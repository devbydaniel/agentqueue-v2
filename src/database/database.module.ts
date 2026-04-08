import { Global, Module } from '@nestjs/common';
import {
  databaseProviders,
  DatabaseShutdownService,
} from './database.providers.js';
import { PG_POOL, DRIZZLE } from './database.tokens.js';

@Global()
@Module({
  providers: [...databaseProviders, DatabaseShutdownService],
  exports: [PG_POOL, DRIZZLE],
})
export class DatabaseModule {}
