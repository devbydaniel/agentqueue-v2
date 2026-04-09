import { Module } from '@nestjs/common';
import { CALLBACK_HANDLERS } from './constants.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';
import { LangfuseCallbackHandlerFactory } from './handlers/langfuse.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    LangfuseCallbackHandlerFactory,
    {
      provide: CALLBACK_HANDLERS,
      useFactory: (logger: LoggerCallbackHandler) => [logger],
      inject: [LoggerCallbackHandler],
    },
  ],
  exports: [CALLBACK_HANDLERS, LangfuseCallbackHandlerFactory],
})
export class CallbacksModule {}
