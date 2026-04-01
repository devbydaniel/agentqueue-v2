import { Global, Module } from '@nestjs/common';
import { AgentfilesConfigService } from './agentfiles-config.service.js';

@Global()
@Module({
  providers: [AgentfilesConfigService],
  exports: [AgentfilesConfigService],
})
export class ConfigModule {}
