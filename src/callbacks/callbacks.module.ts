import { Module } from '@nestjs/common';
import { RUN_EVENT_HANDLERS } from './constants.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';
import { LangfuseCallbackHandlerFactory } from './handlers/langfuse.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    LangfuseCallbackHandlerFactory,
    {
      provide: RUN_EVENT_HANDLERS,
      useFactory: (logger: LoggerCallbackHandler) => [logger],
      inject: [LoggerCallbackHandler],
    },
  ],
  exports: [RUN_EVENT_HANDLERS, LangfuseCallbackHandlerFactory],
})
export class CallbacksModule {}
