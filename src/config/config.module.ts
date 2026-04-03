import { Global, Module } from '@nestjs/common';
import { AgentfilesConfigService } from './agentfiles-config.service.js';
import { AppConfigService } from './app-config.service.js';

@Global()
@Module({
  providers: [AppConfigService, AgentfilesConfigService],
  exports: [AppConfigService, AgentfilesConfigService],
})
export class ConfigModule {}
