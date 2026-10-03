import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { VoxtralTranscriptionService } from '../telegram/voxtral-transcription.service.js';
import { MatrixModule } from './matrix.module.js';
import { MatrixIngestService } from './matrix-ingest.service.js';
import { MatrixListenerService } from './matrix-listener.service.js';
import { MatrixMediaService } from './matrix-media.service.js';
import { MatrixSyncStateRepository } from './matrix-sync-state.repository.js';

@Module({
  imports: [RunsModule, MatrixModule],
  providers: [
    ExternalSessionRepository,
    MatrixIngestService,
    MatrixListenerService,
    MatrixMediaService,
    MatrixSyncStateRepository,
    VoxtralTranscriptionService,
  ],
})
export class MatrixListenerModule {}
