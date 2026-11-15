import { Module } from '@nestjs/common';
import { SpeechModule } from '../speech/speech.module.js';
import { MatrixService } from './matrix.service.js';
import { MatrixStreamingCallbackHandlerFactory } from './matrix-streaming.callback-handler.js';
import { MatrixActiveCallsService } from './matrix-active-calls.service.js';
import { MatrixCallCallbackHandlerFactory } from './matrix-call.callback-handler.js';

@Module({
  imports: [SpeechModule],
  providers: [
    MatrixService,
    MatrixStreamingCallbackHandlerFactory,
    MatrixActiveCallsService,
    MatrixCallCallbackHandlerFactory,
  ],
  exports: [
    MatrixService,
    MatrixStreamingCallbackHandlerFactory,
    MatrixActiveCallsService,
    MatrixCallCallbackHandlerFactory,
  ],
})
export class MatrixModule {}
