import { Global, Module } from '@nestjs/common';
import { AgentfilesConfigService } from './agentfiles-config.service.js';
import { AppConfigService } from './app-config.service.js';
import { TriggerConfigService } from './trigger-config.service.js';

@Global()
@Module({
  providers: [AppConfigService, AgentfilesConfigService, TriggerConfigService],
  exports: [AppConfigService, AgentfilesConfigService, TriggerConfigService],
})
export class ConfigModule {}
