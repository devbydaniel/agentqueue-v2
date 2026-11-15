import { createHash } from 'node:crypto';
import {
  CALL_MEMBER_EVENT_TYPE,
  type LivekitTokenRequest,
  type MatrixEvent,
} from './matrix-client.js';

/**
 * Pure helpers for MatrixRTC calls as Element Call 0.28 writes them in its
 * default "Compatibility" mode (matrix-js-sdk MembershipManager, MSC4143
 * session memberships): one `org.matrix.msc3401.call.member` state event per
 * participating device, a LiveKit SFU as the transport (MSC4195).
 */

/** The room-wide call slot (`m.call` application, `ROOM` id), as sent to get_token. */
export const CALL_SLOT_ID = 'm.call#ROOM';
/** How long a membership is valid without renewal (js-sdk DEFAULT_EXPIRE_DURATION). */
export const MEMBERSHIP_EXPIRES_MS = 4 * 60 * 60 * 1000;
/** The homeserver posts our leave this long after the last restart (Element Call's default). */
export const DELAYED_LEAVE_DELAY_MS = 18_000;
/** How often the delayed leave is restarted while the bot is in the call. */
export const DELAYED_LEAVE_RESTART_MS = 5_000;

/**
 * State key of a device's membership: `_{userId}_{deviceId}_m.call`. The
 * room slot's id `ROOM` is written as `""` here (js-sdk's legacy slot fix), and
 * the leading underscore keeps Synapse from treating the key as a user ID.
 */
export function membershipStateKey(userId: string, deviceId: string): string {
  return `_${userId}_${deviceId}_m.call`;
}

/** Member id of a session membership; also what get_token's `member_id` gets. */
export function membershipId(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export interface MembershipContentParams {
  userId: string;
  deviceId: string;
  /** The SFU URL advertised to clients, e.g. `wss://livekit.example`. */
  livekitUrl: string;
}

/** Content of the bot's own call membership, mirroring js-sdk's makeMyMembership. */
export function buildMembershipContent(
  params: MembershipContentParams,
): Record<string, unknown> {
  return {
    application: 'm.call',
    call_id: '',
    scope: 'm.room',
    device_id: params.deviceId,
    membershipID: membershipId(params.userId, params.deviceId),
    expires: MEMBERSHIP_EXPIRES_MS,
    'm.call.intent': 'audio',
    focus_active: { type: 'livekit', focus_selection: 'multi_sfu' },
    foci_preferred: [{ type: 'livekit', url: params.livekitUrl }],
  };
}

/**
 * Body of `POST /_matrix/client/v1/rtc/livekit/get_token` (MSC4195). `url`
 * must equal the SFU URL the JWT service is configured with, byte for byte.
 */
export function buildLivekitTokenRequest(
  livekitUrl: string,
  roomId: string,
  memberId: string,
): LivekitTokenRequest {
  return {
    url: livekitUrl,
    room_id: roomId,
    slot_id: CALL_SLOT_ID,
    member_id: memberId,
  };
}

/**
 * LiveKit participant identity the JWT service assigns to a member:
 * unpadded base64 of sha256 over the JSON array `[userId, memberId]`.
 */
export function livekitIdentity(userId: string, memberId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([userId, memberId]))
    .digest('base64')
    .replaceAll('=', '');
}

export interface CallMembershipUpdate {
  sender: string;
  stateKey: string;
  /** False for an emptied (left) or expired membership. */
  active: boolean;
  /** The member's LiveKit identity, for an active membership. */
  livekitIdentity?: string;
}

/**
 * Call membership changes among a room's synced events, oldest first. Pass
 * the sync's `state` events before its `timeline` events, so later updates of
 * the same device win.
 */
export function parseCallMemberships(
  events: readonly MatrixEvent[],
  now: number,
): CallMembershipUpdate[] {
  return events
    .filter(
      (e) =>
        e.type === CALL_MEMBER_EVENT_TYPE && typeof e.state_key === 'string',
    )
    .map((e) => parseMembership(e, now));
}

function parseMembership(
  event: MatrixEvent,
  now: number,
): CallMembershipUpdate {
  const base = { sender: event.sender, stateKey: event.state_key! };
  const content = event.content;
  const deviceId = content['device_id'];
  if (content['application'] !== 'm.call' || typeof deviceId !== 'string') {
    return { ...base, active: false };
  }
  const createdTs =
    typeof content['created_ts'] === 'number'
      ? content['created_ts']
      : event.origin_server_ts;
  const expires =
    typeof content['expires'] === 'number'
      ? content['expires']
      : MEMBERSHIP_EXPIRES_MS;
  if (createdTs + expires <= now) return { ...base, active: false };

  const memberId =
    typeof content['membershipID'] === 'string'
      ? content['membershipID']
      : membershipId(event.sender, deviceId);
  return {
    ...base,
    active: true,
    livekitIdentity: livekitIdentity(event.sender, memberId),
  };
}
