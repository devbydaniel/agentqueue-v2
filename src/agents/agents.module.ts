import { Module } from '@nestjs/common';
import { AgentProfileService } from './agent-profile.service.js';

@Module({
  providers: [AgentProfileService],
  exports: [AgentProfileService],
})
export class AgentsModule {}
