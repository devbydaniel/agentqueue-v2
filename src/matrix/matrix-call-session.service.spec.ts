import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MatrixTrigger } from '../config/trigger-config.interface.js';
import type { RunsService } from '../runs/runs.service.js';
import type { ExternalSessionRepository } from '../runs/external-session.repository.js';
import type { VoxtralTranscriptionService } from '../speech/voxtral-transcription.service.js';
import type { Utterance } from '../speech/turn-detector.js';
import type { MatrixService } from './matrix.service.js';
import type { MatrixIngestService } from './matrix-ingest.service.js';
import {
  CALL_SYSTEM_PROMPT,
  MatrixCallSessionService,
  type CallContext,
} from './matrix-call-session.service.js';

const ROOM = '!call:hs';
const SESSION = 'matrix:assistant:!call:hs:$root';

describe('MatrixCallSessionService', () => {
  let cwd: string;
  let sendMessage: jest.Mock;
  let matrixService: Record<string, jest.Mock>;
  let runsService: { steerSession: jest.Mock; enqueue: jest.Mock };
  let sessions: { upsertSession: jest.Mock };
  let transcription: { transcribeAudio: jest.Mock };
  let service: MatrixCallSessionService;
  let call: CallContext;

  const utterance: Utterance = {
    samples: new Int16Array(1_600),
    sampleRate: 16_000,
    durationMs: 100,
    speechMs: 100,
    truncated: false,
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-call-'));
    sendMessage = jest.fn().mockResolvedValue('$root');
    matrixService = {
      getClient: jest.fn().mockReturnValue({ sendMessage }),
      sendNotice: jest.fn().mockResolvedValue(undefined),
      startTyping: jest.fn(),
      stopTyping: jest.fn(),
    };
    runsService = {
      steerSession: jest.fn().mockResolvedValue(false),
      enqueue: jest.fn().mockResolvedValue({ runId: 'r1' }),
    };
    sessions = { upsertSession: jest.fn().mockResolvedValue(undefined) };
    transcription = {
      transcribeAudio: jest.fn().mockResolvedValue(' Wie wird das Wetter? '),
    };
    service = new MatrixCallSessionService(
      matrixService as unknown as MatrixService,
      {
        triggerSystemPrompt: () => 'Trigger prompt',
      } as unknown as MatrixIngestService,
      runsService as unknown as RunsService,
      sessions as unknown as ExternalSessionRepository,
      transcription as unknown as VoxtralTranscriptionService,
    );
    call = {
      id: 'c1',
      botName: 'assistant',
      roomId: ROOM,
      trigger: {
        name: 'matrix-daniel',
        cwd,
        timeout_ms: 600_000,
      } as MatrixTrigger,
    };
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('roots the call session in a top-level call message', async () => {
    await service.openThread(call);

    expect(sendMessage).toHaveBeenCalledWith(ROOM, {
      msgtype: 'm.notice',
      body: '📞 Call',
    });
    expect(call.sessionKey).toBe(SESSION);
    expect(call.target).toEqual({
      botName: 'assistant',
      roomId: ROOM,
      threadRootId: '$root',
    });
    expect(sessions.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'matrix', sessionKey: SESSION }),
    );
  });

  it('transcribes a turn as WAV, echoes it in the thread and starts a voice run', async () => {
    await service.openThread(call);
    await service.handleTurn(call, utterance);

    const [wav, , contentType] = transcription.transcribeAudio.mock
      .calls[0] as [Buffer, string, string];
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(contentType).toBe('audio/wav');
    expect(matrixService.sendNotice).toHaveBeenCalledWith(
      call.target,
      '🎤 Wie wird das Wetter?',
    );
    expect(matrixService.startTyping).toHaveBeenCalledWith(SESSION);
    expect(runsService.enqueue).toHaveBeenCalledWith({
      source: 'matrix',
      triggerName: 'matrix-daniel',
      cwd,
      prompt: '[Live call, the user said]: Wie wird das Wetter?',
      externalSessionId: SESSION,
      appendSystemPrompt: `Trigger prompt\n\n${CALL_SYSTEM_PROMPT}`,
      timeoutMs: 600_000,
    });
  });

  it('steers the run in progress instead of starting another', async () => {
    runsService.steerSession.mockResolvedValue(true);
    await service.openThread(call);
    await service.handleTurn(call, utterance);

    expect(runsService.steerSession).toHaveBeenCalledWith(
      SESSION,
      '[Live call, the user said]: Wie wird das Wetter?',
    );
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('drops turns that transcribe to nothing', async () => {
    transcription.transcribeAudio.mockResolvedValue('  ');
    await service.openThread(call);
    await service.handleTurn(call, utterance);

    expect(matrixService.sendNotice).not.toHaveBeenCalled();
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('stops typing again when the run cannot be enqueued', async () => {
    runsService.enqueue.mockRejectedValue(new Error('queue down'));
    await service.openThread(call);
    await expect(service.handleTurn(call, utterance)).rejects.toThrow(
      'queue down',
    );
    expect(matrixService.stopTyping).toHaveBeenCalledWith(SESSION);
  });
});
