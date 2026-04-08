import { Global, Module } from '@nestjs/common';
import { bossProvider, BossLifecycleService } from './queue.providers.js';
import { BOSS } from './queue.tokens.js';

@Global()
@Module({
  providers: [bossProvider, BossLifecycleService],
  exports: [BOSS],
})
export class QueueModule {}
