import { Module } from '@nestjs/common';
import { CALLBACK_HANDLERS } from './constants.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';
import { LangfuseCallbackHandler } from './handlers/langfuse.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    LangfuseCallbackHandler,
    {
      provide: CALLBACK_HANDLERS,
      useFactory: (
        logger: LoggerCallbackHandler,
        langfuse: LangfuseCallbackHandler,
      ) => [logger, langfuse],
      inject: [LoggerCallbackHandler, LangfuseCallbackHandler],
    },
  ],
  exports: [CALLBACK_HANDLERS],
})
export class CallbacksModule {}
