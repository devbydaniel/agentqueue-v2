import { Module } from '@nestjs/common';
import { OpenaiTtsService } from './openai-tts.service.js';
import { VoxtralTranscriptionService } from './voxtral-transcription.service.js';

/** Text-to-speech and speech-to-text, shared by the chat connectors. */
@Module({
  providers: [OpenaiTtsService, VoxtralTranscriptionService],
  exports: [OpenaiTtsService, VoxtralTranscriptionService],
})
export class SpeechModule {}
