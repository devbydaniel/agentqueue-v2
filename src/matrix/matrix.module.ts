import { Module } from '@nestjs/common';
import { SpeechModule } from '../speech/speech.module.js';
import { MatrixService } from './matrix.service.js';
import { MatrixStreamingCallbackHandlerFactory } from './matrix-streaming.callback-handler.js';

@Module({
  imports: [SpeechModule],
  providers: [MatrixService, MatrixStreamingCallbackHandlerFactory],
  exports: [MatrixService, MatrixStreamingCallbackHandlerFactory],
})
export class MatrixModule {}
