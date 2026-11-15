import { Module } from '@nestjs/common';
import { RunsModule } from '../runs/runs.module.js';
import { ExternalSessionRepository } from '../runs/external-session.repository.js';
import { SpeechModule } from '../speech/speech.module.js';
import { MatrixModule } from './matrix.module.js';
import { MatrixIngestService } from './matrix-ingest.service.js';
import { MatrixListenerService } from './matrix-listener.service.js';
import { MatrixCallService } from './matrix-call.service.js';
import { MatrixCallSessionService } from './matrix-call-session.service.js';
import { MatrixMediaService } from './matrix-media.service.js';
import { MatrixSyncStateRepository } from './matrix-sync-state.repository.js';

@Module({
  imports: [RunsModule, MatrixModule, SpeechModule],
  providers: [
    ExternalSessionRepository,
    MatrixIngestService,
    MatrixListenerService,
    MatrixCallService,
    MatrixCallSessionService,
    MatrixMediaService,
    MatrixSyncStateRepository,
  ],
})
export class MatrixListenerModule {}
