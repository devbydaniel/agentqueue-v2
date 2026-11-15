import { MatrixClient } from './matrix-client.js';

describe('MatrixClient call endpoints', () => {
  let fetchMock: jest.Mock;
  let client: MatrixClient;

  const respond = (status: number, body: unknown = {}) =>
    fetchMock.mockResolvedValueOnce({
      ok: status < 400,
      status,
      text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    });

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new MatrixClient('https://synapse.example', 'tok');
  });

  const call = (i = 0) =>
    fetchMock.mock.calls[i] as [string, { method: string; body?: string }];

  it('asks the homeserver for a LiveKit JWT', async () => {
    respond(200, { jwt: 'the-jwt' });
    const request = {
      url: 'wss://lk.example',
      room_id: '!r:hs',
      slot_id: 'm.call#ROOM',
      member_id: '@a:hs:DEV',
    };
    await expect(client.getLivekitToken(request)).resolves.toBe('the-jwt');
    expect(call()[0]).toBe(
      'https://synapse.example/_matrix/client/v1/rtc/livekit/get_token',
    );
    expect(call()[1].method).toBe('POST');
    expect(JSON.parse(call()[1].body!)).toEqual(request);
  });

  it('schedules a delayed state event with the MSC4140 query parameter', async () => {
    respond(200, { delay_id: 'd1' });
    await expect(
      client.sendDelayedStateEvent(
        '!r:hs',
        'org.matrix.msc3401.call.member',
        '_@a:hs_DEV_m.call',
        {},
        18_000,
      ),
    ).resolves.toBe('d1');
    expect(call()[0]).toBe(
      'https://synapse.example/_matrix/client/v3/rooms/!r%3Ahs/state/org.matrix.msc3401.call.member/_%40a%3Ahs_DEV_m.call?org.matrix.msc4140.delay=18000',
    );
    expect(call()[1].method).toBe('PUT');
  });

  it('restarts, sends and cancels delayed events by id', async () => {
    respond(200);
    await client.updateDelayedEvent('d1', 'restart');
    expect(call()[0]).toBe(
      'https://synapse.example/_matrix/client/unstable/org.matrix.msc4140/delayed_events/d1/restart',
    );
    expect(call()[1].method).toBe('POST');
  });

  it('tells encrypted rooms from unencrypted ones', async () => {
    respond(200, { algorithm: 'm.megolm.v1.aes-sha2' });
    await expect(client.isRoomEncrypted('!e:hs')).resolves.toBe(true);
    respond(404, { errcode: 'M_NOT_FOUND' });
    await expect(client.isRoomEncrypted('!p:hs')).resolves.toBe(false);
    expect(call()[0]).toBe(
      'https://synapse.example/_matrix/client/v3/rooms/!e%3Ahs/state/m.room.encryption/',
    );
  });

  it('returns user and device from whoami', async () => {
    respond(200, { user_id: '@a:hs', device_id: 'DEV' });
    await expect(client.whoami()).resolves.toEqual({
      user_id: '@a:hs',
      device_id: 'DEV',
    });
  });
});
