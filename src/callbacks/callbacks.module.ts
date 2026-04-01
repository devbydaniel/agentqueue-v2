import { Module } from '@nestjs/common';
import { CALLBACK_HANDLERS } from './constants.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    {
      provide: CALLBACK_HANDLERS,
      useFactory: (logger: LoggerCallbackHandler) => [logger],
      inject: [LoggerCallbackHandler],
    },
  ],
  exports: [CALLBACK_HANDLERS],
})
export class CallbacksModule {}
