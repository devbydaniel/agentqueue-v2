import { Global, Module } from '@nestjs/common';
import { AppConfigService } from './app-config.service.js';
import { TriggerConfigService } from './trigger-config.service.js';

@Global()
@Module({
  providers: [AppConfigService, TriggerConfigService],
  exports: [AppConfigService, TriggerConfigService],
})
export class ConfigModule {}
