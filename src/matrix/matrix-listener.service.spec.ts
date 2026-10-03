import { MatrixListenerService } from './matrix-listener.service.js';
import type { MatrixEvent, SyncResponse } from './matrix-client.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { MatrixService } from './matrix.service.js';
import type { MatrixSyncStateRepository } from './matrix-sync-state.repository.js';
import type { MatrixIngestService } from './matrix-ingest.service.js';

function message(
  id: string,
  body: string,
  extra: Partial<MatrixEvent> = {},
  content: Record<string, unknown> = {},
): MatrixEvent {
  return {
    event_id: id,
    type: 'm.room.message',
    sender: '@daniel:hs',
    origin_server_ts: Date.now(),
    content: { msgtype: 'm.text', body, ...content },
    ...extra,
  };
}

function invite(roomId: string, inviter: string): SyncResponse {
  return {
    next_batch: 's1',
    rooms: {
      invite: {
        [roomId]: {
          invite_state: {
            events: [
              {
                event_id: '$inv',
                type: 'm.room.member',
                sender: inviter,
                state_key: '@assistant:hs',
                origin_server_ts: 0,
                content: { membership: 'invite' },
              },
            ],
          },
        },
      },
    },
  };
}

describe('MatrixListenerService', () => {
  let joinRoom: jest.Mock;
  let sendNotice: jest.Mock;
  let ingest: { ingest: jest.Mock; resolveTrigger: jest.Mock };
  let listener: MatrixListenerService;
  let handleSync: (response: SyncResponse) => Promise<void>;

  beforeEach(() => {
    joinRoom = jest.fn().mockResolvedValue(undefined);
    sendNotice = jest.fn().mockResolvedValue(undefined);
    const client = { joinRoom };
    const matrixService = {
      getClient: jest.fn().mockReturnValue(client),
      getUserId: jest.fn().mockReturnValue('@assistant:hs'),
      sendNotice,
    };
    ingest = {
      ingest: jest.fn().mockResolvedValue(undefined),
      resolveTrigger: jest
        .fn()
        .mockImplementation((_bot: string, sender: string) =>
          sender === '@daniel:hs' ? { name: 't' } : undefined,
        ),
    };
    listener = new MatrixListenerService(
      {} as TriggerConfigService,
      matrixService as unknown as MatrixService,
      {} as MatrixSyncStateRepository,
      ingest as unknown as MatrixIngestService,
    );
    // handleSync is the unit under test; the long-poll loop around it is I/O.
    handleSync = (response) =>
      (
        listener as unknown as {
          handleSync: (b: string, c: unknown, r: SyncResponse) => Promise<void>;
        }
      ).handleSync('assistant', client, response);
  });

  it('joins rooms only when an allowed user invites', async () => {
    await handleSync(invite('!ok:hs', '@daniel:hs'));
    await handleSync(invite('!bad:hs', '@stranger:hs'));
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(joinRoom).toHaveBeenCalledWith('!ok:hs');
  });

  it('batches messages per room and thread, skipping its own and edits', async () => {
    await handleSync({
      next_batch: 's2',
      rooms: {
        join: {
          '!r:hs': {
            timeline: {
              events: [
                message('$1', 'one'),
                message('$2', 'two'),
                message('$3', 'mine', { sender: '@assistant:hs' }),
                message(
                  '$4',
                  'edit',
                  {},
                  {
                    'm.relates_to': { rel_type: 'm.replace', event_id: '$1' },
                  },
                ),
                message(
                  '$5',
                  'threaded',
                  {},
                  {
                    'm.relates_to': { rel_type: 'm.thread', event_id: '$root' },
                  },
                ),
              ],
            },
          },
        },
      },
    });

    const batches = ingest.ingest.mock.calls.map(
      (call) =>
        call[0] as { threadRootId?: string; messages: { eventId: string }[] },
    );
    expect(batches).toHaveLength(2);
    expect(batches[0].threadRootId).toBeUndefined();
    expect(batches[0].messages.map((m) => m.eventId)).toEqual(['$1', '$2']);
    expect(batches[1].threadRootId).toBe('$root');
  });

  it('does not replay old history of a freshly joined room', async () => {
    await handleSync(invite('!new:hs', '@daniel:hs'));
    await handleSync({
      next_batch: 's3',
      rooms: {
        join: {
          '!new:hs': {
            timeline: {
              events: [
                message('$old', 'ancient', {
                  origin_server_ts: Date.now() - 24 * 60 * 60 * 1000,
                }),
                message('$fresh', 'hello bot'),
              ],
            },
          },
        },
      },
    });
    const batch = ingest.ingest.mock.calls[0][0] as {
      messages: { eventId: string }[];
    };
    expect(batch.messages.map((m) => m.eventId)).toEqual(['$fresh']);
  });

  it('tells an allowed user once that it cannot read an encrypted room', async () => {
    const encrypted = (id: string, sender = '@daniel:hs'): MatrixEvent => ({
      event_id: id,
      type: 'm.room.encrypted',
      sender,
      origin_server_ts: Date.now(),
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x' },
    });
    const sync = (events: MatrixEvent[]): SyncResponse => ({
      next_batch: 's',
      rooms: { join: { '!enc:hs': { timeline: { events } } } },
    });

    await handleSync(sync([encrypted('$s', '@stranger:hs')]));
    expect(sendNotice).not.toHaveBeenCalled();

    await handleSync(sync([encrypted('$1')]));
    await handleSync(sync([encrypted('$2')]));
    expect(sendNotice).toHaveBeenCalledTimes(1);
    expect(sendNotice).toHaveBeenCalledWith(
      { botName: 'assistant', roomId: '!enc:hs', threadRootId: undefined },
      expect.stringContaining('encrypted'),
    );
    expect(ingest.ingest).not.toHaveBeenCalled();
  });
});
