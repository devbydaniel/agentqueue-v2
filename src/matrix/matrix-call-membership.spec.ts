import {
  CALL_MEMBER_EVENT_TYPE,
  MatrixApiError,
  type MatrixClient,
} from './matrix-client.js';
import { MatrixCallMembership } from './matrix-call-membership.js';
import {
  DELAYED_LEAVE_DELAY_MS,
  DELAYED_LEAVE_RESTART_MS,
} from './matrix-rtc.js';

const STATE_KEY = '_@assistant:hs_DEV_m.call';

describe('MatrixCallMembership', () => {
  let client: {
    sendStateEvent: jest.Mock;
    sendDelayedStateEvent: jest.Mock;
    updateDelayedEvent: jest.Mock;
  };
  let membership: MatrixCallMembership;

  beforeEach(() => {
    jest.useFakeTimers();
    client = {
      sendStateEvent: jest.fn().mockResolvedValue(undefined),
      sendDelayedStateEvent: jest.fn().mockResolvedValue('delay-1'),
      updateDelayedEvent: jest.fn().mockResolvedValue(undefined),
    };
    membership = new MatrixCallMembership(client as unknown as MatrixClient, {
      callId: 'c1',
      roomId: '!call:hs',
      userId: '@assistant:hs',
      deviceId: 'DEV',
      livekitUrl: 'wss://livekit.example',
    });
  });

  afterEach(async () => {
    await membership.leave();
    jest.useRealTimers();
  });

  it('schedules the delayed leave before posting the membership', async () => {
    await membership.join();

    expect(client.sendDelayedStateEvent).toHaveBeenCalledWith(
      '!call:hs',
      CALL_MEMBER_EVENT_TYPE,
      STATE_KEY,
      {},
      DELAYED_LEAVE_DELAY_MS,
    );
    expect(client.sendStateEvent).toHaveBeenCalledWith(
      '!call:hs',
      CALL_MEMBER_EVENT_TYPE,
      STATE_KEY,
      expect.objectContaining({ application: 'm.call', device_id: 'DEV' }),
    );
    expect(
      client.sendDelayedStateEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(client.sendStateEvent.mock.invocationCallOrder[0]);
  });

  it('restarts the delayed leave periodically', async () => {
    await membership.join();
    await jest.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS * 2);
    expect(client.updateDelayedEvent).toHaveBeenCalledTimes(2);
    expect(client.updateDelayedEvent).toHaveBeenCalledWith(
      'delay-1',
      'restart',
    );
  });

  it('reschedules and re-sends the membership when the delayed leave is gone', async () => {
    await membership.join();
    client.updateDelayedEvent.mockRejectedValueOnce(
      new MatrixApiError(404, 'M_NOT_FOUND', 'gone'),
    );
    client.sendDelayedStateEvent.mockResolvedValueOnce('delay-2');
    await jest.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);

    expect(client.sendDelayedStateEvent).toHaveBeenCalledTimes(2);
    expect(client.sendStateEvent).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS);
    expect(client.updateDelayedEvent).toHaveBeenLastCalledWith(
      'delay-2',
      'restart',
    );
  });

  it('leaves by sending the scheduled leave and stops restarting', async () => {
    await membership.join();
    await membership.leave();

    expect(client.updateDelayedEvent).toHaveBeenCalledWith('delay-1', 'send');
    expect(client.sendStateEvent).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(DELAYED_LEAVE_RESTART_MS * 3);
    expect(client.updateDelayedEvent).toHaveBeenCalledTimes(1);
  });

  it('falls back to posting the empty membership if the scheduled leave fails', async () => {
    await membership.join();
    client.updateDelayedEvent.mockRejectedValue(new Error('boom'));
    await membership.leave();

    expect(client.sendStateEvent).toHaveBeenLastCalledWith(
      '!call:hs',
      CALL_MEMBER_EVENT_TYPE,
      STATE_KEY,
      {},
    );
    expect(client.updateDelayedEvent).toHaveBeenLastCalledWith(
      'delay-1',
      'cancel',
    );
  });

  it('still joins when the homeserver has no delayed events', async () => {
    client.sendDelayedStateEvent.mockRejectedValue(
      new MatrixApiError(400, 'M_UNRECOGNIZED', 'nope'),
    );
    await membership.join();
    expect(client.sendStateEvent).toHaveBeenCalledTimes(1);

    await membership.leave();
    expect(client.sendStateEvent).toHaveBeenLastCalledWith(
      '!call:hs',
      CALL_MEMBER_EVENT_TYPE,
      STATE_KEY,
      {},
    );
  });

  it('never throws on leave', async () => {
    await membership.join();
    client.updateDelayedEvent.mockRejectedValue(new Error('down'));
    client.sendStateEvent.mockRejectedValue(new Error('down'));
    await expect(membership.leave()).resolves.toBeUndefined();
  });
});
