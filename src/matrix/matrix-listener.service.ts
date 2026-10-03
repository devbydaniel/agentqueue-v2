import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import type { MatrixClient, SyncResponse } from './matrix-client.js';
import { MatrixService } from './matrix.service.js';
import { MatrixSyncStateRepository } from './matrix-sync-state.repository.js';
import {
  MatrixIngestService,
  type MatrixIngestBatch,
} from './matrix-ingest.service.js';
import { parseInboundMessage } from './matrix-content.js';

const MIN_BACKOFF_MS = 2_000;
// After joining a room, only messages this recent count as new — enough for
// the first message typed while the invite was pending, without replaying
// the history of an existing room.
const JOIN_LOOKBACK_MS = 10 * 60 * 1000;
const MAX_BACKOFF_MS = 60_000;

/**
 * Runs one /sync long-poll loop per Matrix bot: auto-joins rooms that an
 * allowed user invites the bot to, and hands new messages to the ingest
 * service grouped by session (room main timeline or thread).
 */
@Injectable()
export class MatrixListenerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(MatrixListenerService.name);
  private readonly abortController = new AbortController();
  /** Rooms joined by this process, with the join time, until first synced. */
  private readonly freshlyJoined = new Map<string, number>();

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly matrixService: MatrixService,
    private readonly syncStateRepository: MatrixSyncStateRepository,
    private readonly ingestService: MatrixIngestService,
  ) {}

  onApplicationBootstrap(): void {
    const triggers = this.triggerConfigService.getMatrixTriggers();
    if (triggers.length === 0) {
      this.logger.log('No Matrix triggers configured; listener idle');
      return;
    }
    for (const botName of new Set(triggers.map((t) => t.bot_name))) {
      const group = this.triggerConfigService.getMatrixTriggersForBot(botName);
      const inconsistent = group.some(
        (t) =>
          t.homeserver_url !== group[0].homeserver_url ||
          t.access_token !== group[0].access_token,
      );
      if (inconsistent) {
        this.logger.error(
          `Matrix bot "${botName}" has inconsistent homeserver_url or access_token across triggers; skipping`,
        );
        continue;
      }
      void this.runBot(botName);
    }
  }

  onModuleDestroy(): void {
    this.abortController.abort();
  }

  private get stopped(): boolean {
    return this.abortController.signal.aborted;
  }

  private async runBot(botName: string): Promise<void> {
    const client = this.matrixService.getClient(botName)!;
    let backoff = MIN_BACKOFF_MS;
    let since: string | undefined;
    let connected = false;

    while (!this.stopped) {
      try {
        if (!connected) {
          const userId = await client.whoami();
          this.matrixService.registerUserId(botName, userId);
          since = await this.syncStateRepository.getNextBatch(botName);
          since ??= await this.initialSync(botName, client);
          connected = true;
          this.logger.log(`Matrix bot "${botName}" syncing as ${userId}`);
        }
        const response = await client.sync(since, this.abortController.signal);
        await this.handleSync(botName, client, response);
        since = response.next_batch;
        await this.syncStateRepository.setNextBatch(botName, since);
        backoff = MIN_BACKOFF_MS;
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        this.logger.error(`Matrix sync failed for bot "${botName}"`, {
          error: error as Error,
          retryInMs: backoff,
        });
        await sleep(backoff);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * First-ever sync: record the position and accept pending invites, but do
   * not treat the existing room history as new messages.
   */
  private async initialSync(
    botName: string,
    client: MatrixClient,
  ): Promise<string> {
    const response = await client.sync(undefined, this.abortController.signal);
    await this.joinInvitedRooms(botName, client, response);
    await this.syncStateRepository.setNextBatch(botName, response.next_batch);
    return response.next_batch;
  }

  private async handleSync(
    botName: string,
    client: MatrixClient,
    response: SyncResponse,
  ): Promise<void> {
    await this.joinInvitedRooms(botName, client, response);
    for (const batch of this.collectBatches(botName, response)) {
      // Ingest downloads/transcribes media; don't hold up the sync loop.
      void this.ingestService.ingest(batch).catch((error: unknown) => {
        this.logger.error('Matrix ingest failed', {
          error: error as Error,
          roomId: batch.roomId,
        });
      });
    }
  }

  private async joinInvitedRooms(
    botName: string,
    client: MatrixClient,
    response: SyncResponse,
  ): Promise<void> {
    const botUserId = this.matrixService.getUserId(botName);
    for (const [roomId, room] of Object.entries(response.rooms?.invite ?? {})) {
      const invite = room.invite_state?.events?.find(
        (e) =>
          e.type === 'm.room.member' &&
          e.state_key === botUserId &&
          e.content['membership'] === 'invite',
      );
      const inviter = invite?.sender;
      if (
        !inviter ||
        !this.ingestService.resolveTrigger(botName, inviter, roomId)
      ) {
        this.logger.warn('Ignoring Matrix invite from unauthorized user', {
          botName,
          roomId,
          inviter,
        });
        continue;
      }
      try {
        await client.joinRoom(roomId);
        this.freshlyJoined.set(roomId, Date.now());
        this.logger.log(`Matrix bot "${botName}" joined ${roomId}`);
      } catch (error) {
        this.logger.error('Failed to join Matrix room', {
          error: error as Error,
          roomId,
        });
      }
    }
  }

  /** Group consecutive messages per (room, thread) so a burst becomes one run. */
  private collectBatches(
    botName: string,
    response: SyncResponse,
  ): MatrixIngestBatch[] {
    const botUserId = this.matrixService.getUserId(botName);
    const batches = new Map<string, MatrixIngestBatch>();
    for (const [roomId, room] of Object.entries(response.rooms?.join ?? {})) {
      const joinedAt = this.freshlyJoined.get(roomId);
      this.freshlyJoined.delete(roomId);
      for (const event of room.timeline?.events ?? []) {
        if (event.sender === botUserId) continue;
        if (joinedAt && event.origin_server_ts < joinedAt - JOIN_LOOKBACK_MS) {
          continue;
        }
        const message = parseInboundMessage(event);
        if (!message) continue;
        const key = `${roomId}|${message.threadRootId ?? ''}|${message.sender}`;
        const batch = batches.get(key) ?? {
          botName,
          roomId,
          threadRootId: message.threadRootId,
          messages: [],
        };
        batch.messages.push(message);
        batches.set(key, batch);
      }
    }
    return [...batches.values()];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
