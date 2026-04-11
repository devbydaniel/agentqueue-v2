import { Global, Module } from '@nestjs/common';
import { AgentProfileService } from './agent-profile.service.js';

@Global()
@Module({
  providers: [AgentProfileService],
  exports: [AgentProfileService],
})
export class AgentsModule {}
