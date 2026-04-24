import { Module } from '@nestjs/common';
import { SlackService } from './slack.service.js';
import { SlackStreamingCallbackHandlerFactory } from './slack-streaming.callback-handler.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';

@Module({
  providers: [
    SlackService,
    SlackStreamingCallbackHandlerFactory,
    ExternalSessionRepository,
  ],
  exports: [
    SlackService,
    SlackStreamingCallbackHandlerFactory,
    ExternalSessionRepository,
  ],
})
export class SlackModule {}
