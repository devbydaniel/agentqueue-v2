import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { MatrixService } from './matrix.service.js';
import { MatrixStreamingCallbackHandlerFactory } from './matrix-streaming.callback-handler.js';

@Module({
  imports: [TelegramModule],
  providers: [MatrixService, MatrixStreamingCallbackHandlerFactory],
  exports: [MatrixService, MatrixStreamingCallbackHandlerFactory],
})
export class MatrixModule {}
