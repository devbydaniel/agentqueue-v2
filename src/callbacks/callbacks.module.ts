import { Module } from '@nestjs/common';
import {
  CallbackManager,
  CALLBACK_HANDLERS,
} from './callback-manager.service.js';
import { LoggerCallbackHandler } from './handlers/logger.callback-handler.js';

@Module({
  providers: [
    LoggerCallbackHandler,
    {
      provide: CALLBACK_HANDLERS,
      useFactory: (logger: LoggerCallbackHandler) => [logger],
      inject: [LoggerCallbackHandler],
    },
    CallbackManager,
  ],
  exports: [CallbackManager],
})
export class CallbacksModule {}
