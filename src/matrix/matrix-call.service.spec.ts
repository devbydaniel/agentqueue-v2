import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { MatrixTrigger } from '../config/trigger-config.interface.js';
import type { OpenaiTtsService } from '../speech/openai-tts.service.js';
import type { VoxtralTranscriptionService } from '../speech/voxtral-transcription.service.js';
import {
  CALL_MEMBER_EVENT_TYPE,
  type MatrixEvent,
  type SyncResponse,
} from './matrix-client.js';
import type { MatrixService } from './matrix.service.js';
import { MatrixActiveCallsService } from './matrix-active-calls.service.js';
import type { MatrixCallSessionService } from './matrix-call-session.service.js';
import { CALL_GREETING, MatrixCallService } from './matrix-call.service.js';
import { MatrixCallMedia, type CallMediaEvents } from './matrix-call-media.js';

interface FakeMedia {
  events: CallMediaEvents;
  connect: jest.Mock;
  play: jest.Mock;
  close: jest.Mock;
}
const medias: FakeMedia[] = [];

// The real media class loads the native LiveKit SDK.
jest.mock('./matrix-call-media.js', () => ({
  CALLER_SAMPLE_RATE: 16_000,
  PLAYBACK_SAMPLE_RATE: 24_000,
  MatrixCallMedia: jest.fn(),
}));

const ROOM = '!call:hs';
const DANIEL = '@daniel:hs';

function membership(content: Record<string, unknown>): SyncResponse {
  const event: MatrixEvent = {
    event_id: '$m',
    type: CALL_MEMBER_EVENT_TYPE,
    sender: DANIEL,
    state_key: `_${DANIEL}_PHONE_m.call`,
    origin_server_ts: Date.now(),
    content,
  };
  return {
    next_batch: 's',
    rooms: { join: { [ROOM]: { timeline: { events: [event] } } } },
  };
}

const JOIN = {
  application: 'm.call',
  call_id: '',
  device_id: 'PHONE',
  focus_active: { type: 'livekit', focus_selection: 'multi_sfu' },
  foci_preferred: [{ type: 'livekit', url: 'wss://lk.example' }],
};

/** Let the fire-and-forget join/leave chains run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('MatrixCallService', () => {
  let client: Record<string, jest.Mock>;
  let matrixService: Record<string, jest.Mock>;
  let sessionService: Record<string, jest.Mock>;
  let activeCalls: MatrixActiveCallsService;
  let tts: { isAvailable: jest.Mock; streamPcm: jest.Mock };
  let service: MatrixCallService;

  beforeEach(() => {
    medias.length = 0;
    (MatrixCallMedia as unknown as jest.Mock).mockImplementation(
      (_id: string, events: CallMediaEvents) => {
        const media: FakeMedia = {
          events,
          connect: jest.fn().mockResolvedValue(undefined),
          play: jest.fn().mockResolvedValue(undefined),
          close: jest.fn().mockResolvedValue(undefined),
        };
        medias.push(media);
        return media;
      },
    );
    client = {
      isRoomEncrypted: jest.fn().mockResolvedValue(false),
      getLivekitToken: jest.fn().mockResolvedValue('jwt'),
      sendStateEvent: jest.fn().mockResolvedValue(undefined),
      sendDelayedStateEvent: jest.fn().mockResolvedValue('delay'),
      updateDelayedEvent: jest.fn().mockResolvedValue(undefined),
    };
    matrixService = {
      getClient: jest.fn().mockReturnValue(client),
      getUserId: jest.fn().mockReturnValue('@assistant:hs'),
      getDeviceId: jest.fn().mockReturnValue('BOT'),
    };
    sessionService = {
      openThread: jest
        .fn()
        .mockImplementation((call: { sessionKey?: string }) => {
          call.sessionKey = 'matrix:assistant:!call:hs:$root';
          return Promise.resolve();
        }),
      handleTurn: jest.fn().mockResolvedValue(undefined),
      notice: jest.fn().mockResolvedValue(undefined),
    };
    activeCalls = new MatrixActiveCallsService();
    tts = {
      isAvailable: jest.fn().mockReturnValue(true),
      streamPcm: jest.fn().mockImplementation(async function* () {}),
    };
    const trigger: Partial<MatrixTrigger> = {
      name: 'matrix-daniel',
      bot_name: 'assistant',
      user_id: DANIEL,
      call_room_id: ROOM,
      livekit_url: 'wss://lk.example',
      livekit_internal_url: 'ws://lk.internal:7880',
    };
    service = new MatrixCallService(
      {
        getMatrixTriggersForBot: () => [trigger],
      } as unknown as TriggerConfigService,
      matrixService as unknown as MatrixService,
      activeCalls,
      sessionService as unknown as MatrixCallSessionService,
      tts as unknown as OpenaiTtsService,
      {
        isAvailable: () => true,
      } as unknown as VoxtralTranscriptionService,
    );
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('joins when the caller joins: token, LiveKit, membership, greeting', async () => {
    service.handleSync('assistant', membership(JOIN));
    await settle();

    expect(client.getLivekitToken).toHaveBeenCalledWith({
      url: 'wss://lk.example',
      room_id: ROOM,
      slot_id: 'm.call#ROOM',
      member_id: '@assistant:hs:BOT',
    });
    expect(medias[0].connect).toHaveBeenCalledWith(
      'ws://lk.internal:7880',
      'jwt',
    );
    expect(client.sendStateEvent).toHaveBeenCalledWith(
      ROOM,
      CALL_MEMBER_EVENT_TYPE,
      '_@assistant:hs_BOT_m.call',
      expect.objectContaining({ device_id: 'BOT' }),
    );
    expect(activeCalls.get('matrix:assistant:!call:hs:$root')).toBeDefined();
    expect(tts.streamPcm).toHaveBeenCalledWith(
      CALL_GREETING,
      expect.anything(),
    );
  });

  it('does not join twice while the caller stays', async () => {
    service.handleSync('assistant', membership(JOIN));
    service.handleSync('assistant', membership(JOIN));
    await settle();
    expect(medias).toHaveLength(1);
  });

  it('leaves when the caller hangs up', async () => {
    service.handleSync('assistant', membership(JOIN));
    await settle();
    service.handleSync('assistant', membership({}));
    await settle();

    expect(medias[0].close).toHaveBeenCalled();
    expect(client.updateDelayedEvent).toHaveBeenCalledWith('delay', 'send');
    expect(activeCalls.get('matrix:assistant:!call:hs:$root')).toBeUndefined();
  });

  it('ignores memberships of other users and rooms', async () => {
    const other = membership(JOIN);
    other.rooms!.join![ROOM].timeline!.events![0].sender = '@stranger:hs';
    service.handleSync('assistant', other);
    const elsewhere = membership(JOIN);
    elsewhere.rooms!.join = { '!other:hs': elsewhere.rooms!.join![ROOM] };
    service.handleSync('assistant', elsewhere);
    await settle();
    expect(medias).toHaveLength(0);
  });

  it('refuses calls in encrypted rooms once, until the caller leaves', async () => {
    client.isRoomEncrypted.mockResolvedValue(true);
    service.handleSync('assistant', membership(JOIN));
    await settle();
    service.handleSync('assistant', membership(JOIN));
    await settle();

    expect(sessionService.notice).toHaveBeenCalledTimes(1);
    expect(sessionService.notice.mock.calls[0][1]).toContain('encrypted');
    expect(client.getLivekitToken).not.toHaveBeenCalled();
    expect(medias[0].connect).not.toHaveBeenCalled();
  });

  it('cleans up and says so when joining fails', async () => {
    client.getLivekitToken.mockRejectedValue(new Error('M_FORBIDDEN'));
    service.handleSync('assistant', membership(JOIN));
    await settle();

    expect(sessionService.notice.mock.calls[0][1]).toContain('M_FORBIDDEN');
    expect(medias[0].close).toHaveBeenCalled();
  });

  it('hands a finished turn to the session and plays the cue tone', async () => {
    service.handleSync('assistant', membership(JOIN));
    await settle();
    const { events } = medias[0];
    const frame = (level: number) => new Int16Array(160).fill(level);
    for (let i = 0; i < 50; i++) events.onCallerFrame(frame(4_000));
    for (let i = 0; i < 80; i++) events.onCallerFrame(frame(0));
    await settle();

    expect(sessionService.handleTurn).toHaveBeenCalledTimes(1);
    expect(sessionService.handleTurn.mock.calls[0][1]).toMatchObject({
      speechMs: 500,
      sampleRate: 16_000,
    });
    expect(medias[0].play).toHaveBeenCalled();
  });

  it('ends the call when LiveKit disconnects', async () => {
    service.handleSync('assistant', membership(JOIN));
    await settle();
    medias[0].events.onDisconnected('reason 1');
    await settle();
    expect(medias[0].close).toHaveBeenCalled();
    expect(client.updateDelayedEvent).toHaveBeenCalledWith('delay', 'send');
  });
});
