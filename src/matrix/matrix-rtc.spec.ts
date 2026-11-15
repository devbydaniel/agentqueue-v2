import { createHash } from 'node:crypto';
import { CALL_MEMBER_EVENT_TYPE, type MatrixEvent } from './matrix-client.js';
import {
  buildLivekitTokenRequest,
  buildMembershipContent,
  livekitIdentity,
  MEMBERSHIP_EXPIRES_MS,
  membershipId,
  membershipStateKey,
  parseCallMemberships,
} from './matrix-rtc.js';

const DANIEL = '@daniel:matrix.example';
const NOW = 1_800_000_000_000;

function memberEvent(
  content: Record<string, unknown>,
  extra: Partial<MatrixEvent> = {},
): MatrixEvent {
  return {
    event_id: '$m',
    type: CALL_MEMBER_EVENT_TYPE,
    sender: DANIEL,
    state_key: `_${DANIEL}_PHONE_m.call`,
    origin_server_ts: NOW - 1_000,
    content,
    ...extra,
  };
}

/** What Element Call 0.28 (Compatibility mode) posts when joining. */
const elementCallJoin = {
  application: 'm.call',
  call_id: '',
  scope: 'm.room',
  device_id: 'PHONE',
  membershipID: `${DANIEL}:PHONE`,
  expires: MEMBERSHIP_EXPIRES_MS,
  'm.call.intent': 'audio',
  focus_active: { type: 'livekit', focus_selection: 'multi_sfu' },
  foci_preferred: [{ type: 'livekit', url: 'wss://livekit.example' }],
};

describe('membership identifiers', () => {
  it('builds the legacy state key for the room-wide call slot', () => {
    expect(membershipStateKey('@assistant:hs', 'DEV')).toBe(
      '_@assistant:hs_DEV_m.call',
    );
  });

  it('uses user:device as the member id', () => {
    expect(membershipId('@assistant:hs', 'DEV')).toBe('@assistant:hs:DEV');
  });

  it('derives the LiveKit identity like the JWT service', () => {
    const expected = createHash('sha256')
      .update('["@assistant:hs","@assistant:hs:DEV"]')
      .digest('base64')
      .replace(/=/g, '');
    expect(livekitIdentity('@assistant:hs', '@assistant:hs:DEV')).toBe(
      expected,
    );
    expect(expected).not.toContain('=');
  });
});

describe('buildMembershipContent', () => {
  it('mirrors a Compatibility-mode js-sdk membership with a url transport', () => {
    expect(
      buildMembershipContent({
        userId: '@assistant:hs',
        deviceId: 'DEV',
        livekitUrl: 'wss://livekit.example',
      }),
    ).toEqual({
      application: 'm.call',
      call_id: '',
      scope: 'm.room',
      device_id: 'DEV',
      membershipID: '@assistant:hs:DEV',
      expires: MEMBERSHIP_EXPIRES_MS,
      'm.call.intent': 'audio',
      focus_active: { type: 'livekit', focus_selection: 'multi_sfu' },
      foci_preferred: [{ type: 'livekit', url: 'wss://livekit.example' }],
    });
  });
});

describe('buildLivekitTokenRequest', () => {
  it('asks for the room slot with the exact advertised URL', () => {
    expect(
      buildLivekitTokenRequest(
        'wss://livekit.example',
        '!call:hs',
        '@assistant:hs:DEV',
      ),
    ).toEqual({
      url: 'wss://livekit.example',
      room_id: '!call:hs',
      slot_id: 'm.call#ROOM',
      member_id: '@assistant:hs:DEV',
    });
  });
});

describe('parseCallMemberships', () => {
  it('reads an Element Call join as active with its LiveKit identity', () => {
    expect(parseCallMemberships([memberEvent(elementCallJoin)], NOW)).toEqual([
      {
        sender: DANIEL,
        stateKey: `_${DANIEL}_PHONE_m.call`,
        active: true,
        livekitIdentity: livekitIdentity(DANIEL, `${DANIEL}:PHONE`),
      },
    ]);
  });

  it('falls back to user:device when the member id is missing', () => {
    const content: Record<string, unknown> = { ...elementCallJoin };
    delete content['membershipID'];
    const [update] = parseCallMemberships([memberEvent(content)], NOW);
    expect(update.livekitIdentity).toBe(
      livekitIdentity(DANIEL, `${DANIEL}:PHONE`),
    );
  });

  it('reads empty content as a leave', () => {
    const [update] = parseCallMemberships([memberEvent({})], NOW);
    expect(update).toEqual({
      sender: DANIEL,
      stateKey: `_${DANIEL}_PHONE_m.call`,
      active: false,
    });
  });

  it('treats an expired membership as left', () => {
    const [update] = parseCallMemberships(
      [
        memberEvent(
          { ...elementCallJoin, created_ts: NOW - MEMBERSHIP_EXPIRES_MS - 1 },
          { origin_server_ts: NOW - 10 },
        ),
      ],
      NOW,
    );
    expect(update.active).toBe(false);
  });

  it('measures expiry from the event time when created_ts is absent', () => {
    const [update] = parseCallMemberships(
      [
        memberEvent(
          { ...elementCallJoin, expires: 5_000 },
          { origin_server_ts: NOW - 6_000 },
        ),
      ],
      NOW,
    );
    expect(update.active).toBe(false);
  });

  it('ignores other events and keeps the order of the rest', () => {
    const updates = parseCallMemberships(
      [
        memberEvent(elementCallJoin),
        {
          event_id: '$t',
          type: 'm.room.message',
          sender: DANIEL,
          origin_server_ts: NOW,
          content: { body: 'hi' },
        },
        memberEvent(elementCallJoin, { state_key: undefined }),
        memberEvent({}),
      ],
      NOW,
    );
    expect(updates.map((u) => u.active)).toEqual([true, false]);
  });
});
