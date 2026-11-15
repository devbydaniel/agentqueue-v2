import { Logger } from '@nestjs/common';
import {
  CALL_MEMBER_EVENT_TYPE,
  MatrixApiError,
  type MatrixClient,
} from './matrix-client.js';
import {
  buildMembershipContent,
  DELAYED_LEAVE_DELAY_MS,
  DELAYED_LEAVE_RESTART_MS,
  membershipStateKey,
} from './matrix-rtc.js';

export interface CallMembershipParams {
  callId: string;
  roomId: string;
  userId: string;
  deviceId: string;
  livekitUrl: string;
}

/**
 * The bot's own call membership state event. Joining first schedules the
 * leave (the empty membership) as an MSC4140 delayed event and restarts it
 * every few seconds, like js-sdk's MembershipManager: if the pod dies, the
 * homeserver removes the bot from the call within DELAYED_LEAVE_DELAY_MS.
 */
export class MatrixCallMembership {
  private readonly logger = new Logger(MatrixCallMembership.name);
  private readonly stateKey: string;
  private delayId: string | undefined;
  private timer: NodeJS.Timeout | undefined;
  private restarting = false;
  private left = false;

  constructor(
    private readonly client: MatrixClient,
    private readonly params: CallMembershipParams,
  ) {
    this.stateKey = membershipStateKey(params.userId, params.deviceId);
  }

  async join(): Promise<void> {
    await this.scheduleDelayedLeave();
    await this.sendJoin();
    this.timer = setInterval(
      () => void this.restartDelayedLeave(),
      DELAYED_LEAVE_RESTART_MS,
    );
  }

  /** Remove the membership. Never throws. */
  async leave(): Promise<void> {
    if (this.left) return;
    this.left = true;
    clearInterval(this.timer);
    const delayId = this.delayId;
    this.delayId = undefined;
    // Sending the scheduled leave now also retires the delayed event.
    if (delayId && (await this.tryUpdate(delayId, 'send'))) return;
    try {
      await this.client.sendStateEvent(
        this.params.roomId,
        CALL_MEMBER_EVENT_TYPE,
        this.stateKey,
        {},
      );
    } catch (error) {
      this.logger.error('Failed to leave the call', {
        error: error as Error,
        callId: this.params.callId,
      });
    }
    if (delayId) await this.tryUpdate(delayId, 'cancel');
  }

  private sendJoin(): Promise<void> {
    return this.client.sendStateEvent(
      this.params.roomId,
      CALL_MEMBER_EVENT_TYPE,
      this.stateKey,
      buildMembershipContent(this.params),
    );
  }

  /** Without delayed events the membership still works, it just can't clean up after a crash. */
  private async scheduleDelayedLeave(): Promise<void> {
    try {
      const delayId = await this.client.sendDelayedStateEvent(
        this.params.roomId,
        CALL_MEMBER_EVENT_TYPE,
        this.stateKey,
        {},
        DELAYED_LEAVE_DELAY_MS,
      );
      // Left meanwhile: a stray leave would end the next call in this room.
      if (this.left) await this.tryUpdate(delayId, 'cancel');
      else this.delayId = delayId;
    } catch (error) {
      this.logger.warn('Could not schedule the delayed call leave', {
        error: error as Error,
        callId: this.params.callId,
      });
    }
  }

  private async restartDelayedLeave(): Promise<void> {
    if (this.restarting || this.left) return;
    this.restarting = true;
    try {
      if (!this.delayId) {
        await this.scheduleDelayedLeave();
        return;
      }
      await this.client.updateDelayedEvent(this.delayId, 'restart');
    } catch (error) {
      await this.recoverFromFailedRestart(error);
    } finally {
      this.restarting = false;
    }
  }

  /**
   * A delayed event the homeserver no longer knows has fired or was lost:
   * schedule a new one and re-send the membership in case it was removed.
   */
  private async recoverFromFailedRestart(error: unknown): Promise<void> {
    const gone = error instanceof MatrixApiError && error.status === 404;
    if (!gone) {
      this.logger.warn('Failed to restart the delayed call leave', {
        error: error as Error,
        callId: this.params.callId,
      });
      return;
    }
    this.delayId = undefined;
    if (this.left) return;
    this.logger.warn('Delayed call leave is gone; rejoining', {
      callId: this.params.callId,
    });
    await this.scheduleDelayedLeave();
    try {
      await this.sendJoin();
    } catch (sendError) {
      this.logger.error('Failed to re-send the call membership', {
        error: sendError as Error,
        callId: this.params.callId,
      });
    }
  }

  private async tryUpdate(
    delayId: string,
    action: 'send' | 'cancel',
  ): Promise<boolean> {
    try {
      await this.client.updateDelayedEvent(delayId, action);
      return true;
    } catch (error) {
      this.logger.warn(`Failed to ${action} the delayed call leave`, {
        error: error as Error,
        callId: this.params.callId,
      });
      return false;
    }
  }
}
