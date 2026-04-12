import { Module } from '@nestjs/common';
import { RUN_EVENT_HANDLERS } from './constants.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';
import { LangfuseCallbackHandlerFactory } from './handlers/langfuse.callback-handler.js';
import { LinearCallbackHandlerFactory } from './handlers/linear.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    LangfuseCallbackHandlerFactory,
    LinearCallbackHandlerFactory,
    {
      provide: RUN_EVENT_HANDLERS,
      useFactory: (logger: LoggerCallbackHandler) => [logger],
      inject: [LoggerCallbackHandler],
    },
  ],
  exports: [RUN_EVENT_HANDLERS, LangfuseCallbackHandlerFactory, LinearCallbackHandlerFactory],
})
export class CallbacksModule {}
