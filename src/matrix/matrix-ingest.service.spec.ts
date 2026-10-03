import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MatrixIngestService } from './matrix-ingest.service.js';
import type { InboundMessage } from './matrix-content.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { RunsService } from '../runs/runs.service.js';
import type { ExternalSessionRepository } from '../runs/external-session.repository.js';
import type { MatrixService } from './matrix.service.js';
import type { MatrixMediaService } from './matrix-media.service.js';
import type { VoxtralTranscriptionService } from '../telegram/voxtral-transcription.service.js';

const ROOM = '!room:hs';
const TOP_LEVEL_KEY = `matrix:assistant:${ROOM}:$e1`;

function text(
  body: string,
  extra: Partial<InboundMessage> = {},
): InboundMessage {
  return {
    eventId: '$e1',
    sender: '@daniel:hs',
    kind: 'text',
    text: body,
    ...extra,
  };
}

describe('MatrixIngestService', () => {
  let cwd: string;
  let runsService: { enqueue: jest.Mock; abortSession: jest.Mock };
  let sessions: {
    upsertSession: jest.Mock;
    deleteBySessionKey: jest.Mock;
    findBySessionKey: jest.Mock;
  };
  let getEvent: jest.Mock;
  let matrixService: Record<string, jest.Mock>;
  let mediaService: { download: jest.Mock };
  let transcription: { isAvailable: jest.Mock; transcribe: jest.Mock };
  let service: MatrixIngestService;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-ingest-'));
    const trigger = {
      name: 'matrix-daniel',
      type: 'matrix',
      bot_name: 'assistant',
      homeserver_url: 'https://hs',
      access_token: 't',
      user_id: '@daniel:hs',
      cwd,
    };
    const triggerConfig = {
      getMatrixTriggersForBot: jest.fn().mockReturnValue([trigger]),
    };
    runsService = {
      enqueue: jest.fn().mockResolvedValue({ runId: 'r1' }),
      abortSession: jest.fn(),
    };
    sessions = {
      upsertSession: jest.fn().mockResolvedValue(undefined),
      deleteBySessionKey: jest.fn().mockResolvedValue(undefined),
      findBySessionKey: jest.fn().mockResolvedValue(null),
    };
    getEvent = jest.fn();
    matrixService = {
      getClient: jest.fn().mockReturnValue({ getEvent }),
      getUserId: jest.fn().mockReturnValue('@assistant:hs'),
      startTyping: jest.fn(),
      stopTyping: jest.fn(),
      isVoiceEnabled: jest.fn().mockResolvedValue(false),
      setVoiceEnabled: jest.fn().mockResolvedValue(undefined),
      sendNotice: jest.fn().mockResolvedValue(undefined),
    };
    mediaService = { download: jest.fn().mockResolvedValue('/media/a.png') };
    transcription = {
      isAvailable: jest.fn().mockReturnValue(true),
      transcribe: jest.fn().mockResolvedValue('hello by voice'),
    };
    service = new MatrixIngestService(
      triggerConfig as unknown as TriggerConfigService,
      runsService as unknown as RunsService,
      sessions as unknown as ExternalSessionRepository,
      matrixService as unknown as MatrixService,
      mediaService as unknown as MatrixMediaService,
      transcription as unknown as VoxtralTranscriptionService,
    );
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const ingest = (messages: InboundMessage[], threadRootId?: string) =>
    service.ingest({
      botName: 'assistant',
      roomId: ROOM,
      threadRootId,
      messages,
    });

  it('ignores senders without a matching trigger', async () => {
    await ingest([text('hi', { sender: '@stranger:hs' })]);
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('starts a new thread session rooted at a top-level message', async () => {
    await ingest([text('hello')]);
    expect(sessions.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'matrix',
        sessionKey: TOP_LEVEL_KEY,
      }),
    );
    expect(matrixService.startTyping).toHaveBeenCalledWith(TOP_LEVEL_KEY);
    expect(getEvent).not.toHaveBeenCalled();
    expect(runsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'matrix',
        triggerName: 'matrix-daniel',
        prompt: 'hello',
        externalSessionId: TOP_LEVEL_KEY,
        appendSystemPrompt: expect.stringContaining('Matrix') as unknown,
      }),
    );
  });

  it('keys thread messages by thread root', async () => {
    getEvent.mockResolvedValue({
      sender: '@daniel:hs',
      content: { body: 'root' },
    });
    await ingest([text('in thread', { threadRootId: '$root' })], '$root');
    expect(runsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        externalSessionId: `matrix:assistant:${ROOM}:$root`,
      }),
    );
  });

  it('includes the thread root as context on the first message of a thread', async () => {
    getEvent.mockResolvedValue({
      sender: '@assistant:hs',
      content: { body: 'Daily briefing: 3 meetings' },
    });
    await ingest([text('move the 2pm', { threadRootId: '$root' })], '$root');
    const prompt = (runsService.enqueue.mock.calls[0][0] as { prompt: string })
      .prompt;
    expect(prompt).toContain('written by you');
    expect(prompt).toContain('Daily briefing: 3 meetings');
    expect(prompt).toContain('move the 2pm');
  });

  it('skips thread context once the thread session exists', async () => {
    sessions.findBySessionKey.mockResolvedValue({ sessionKey: 'x' });
    await ingest([text('follow-up', { threadRootId: '$root' })], '$root');
    expect(getEvent).not.toHaveBeenCalled();
  });

  it('includes explicitly quoted messages', async () => {
    getEvent.mockResolvedValue({
      sender: '@assistant:hs',
      content: { body: 'Old answer' },
    });
    await ingest([text('why?', { replyToEventId: '$old' })]);
    expect(getEvent).toHaveBeenCalledWith(ROOM, '$old');
    expect(
      (runsService.enqueue.mock.calls[0][0] as { prompt: string }).prompt,
    ).toContain('Old answer');
  });

  it('turns media into path references and transcribes audio', async () => {
    await ingest([
      {
        eventId: '$i',
        sender: '@daniel:hs',
        kind: 'image',
        mediaUrl: 'mxc://hs/i',
        text: 'what is this',
      },
      {
        eventId: '$a',
        sender: '@daniel:hs',
        kind: 'audio',
        mediaUrl: 'mxc://hs/a',
      },
    ]);
    const prompt = (runsService.enqueue.mock.calls[0][0] as { prompt: string })
      .prompt;
    expect(prompt).toContain('[Image: /media/a.png]\nwhat is this');
    expect(prompt).toContain('[Voice message transcription]: hello by voice');
    expect(matrixService.sendNotice).toHaveBeenCalledWith(
      expect.anything(),
      '🎤 hello by voice',
    );
  });

  it('!new in a thread resets that thread session', async () => {
    await ingest([text('!new', { threadRootId: '$root' })], '$root');
    const key = `matrix:assistant:${ROOM}:$root`;
    expect(sessions.deleteBySessionKey).toHaveBeenCalledWith(key);
    expect(runsService.abortSession).toHaveBeenCalledWith(key);
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('!new at the top level only explains that threads are sessions', async () => {
    await ingest([text('!new')]);
    expect(sessions.deleteBySessionKey).not.toHaveBeenCalled();
    expect(matrixService.sendNotice).toHaveBeenCalledWith(
      expect.objectContaining({ threadRootId: undefined }),
      expect.stringContaining('own thread'),
    );
    expect(runsService.enqueue).not.toHaveBeenCalled();
  });

  it('!voice toggles room voice mode and adds the voice prompt', async () => {
    await ingest([text('!voice')]);
    expect(matrixService.setVoiceEnabled).toHaveBeenCalledWith(
      'assistant',
      ROOM,
      true,
    );

    matrixService.isVoiceEnabled.mockResolvedValue(true);
    await ingest([text('hi')]);
    expect(
      (runsService.enqueue.mock.calls[0][0] as { appendSystemPrompt: string })
        .appendSystemPrompt,
    ).toContain('voice mode ON');
  });
});
