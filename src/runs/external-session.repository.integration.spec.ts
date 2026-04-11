import { ExternalSessionRepository } from './external-session.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { PgPool } from '../database/database.tokens.js';

describe('ExternalSessionRepository (integration)', () => {
  let repo: ExternalSessionRepository;
  let db: PgPool;

  beforeAll(() => {
    db = getTestDb();
    repo = new ExternalSessionRepository(db);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('should return null for unknown session key', async () => {
    expect(await repo.findSessionId('unknown')).toBeNull();
  });

  it('should store and retrieve a session id', async () => {
    await repo.upsertSession({
      provider: 'linear',
      sessionKey: 'key-1',
      sessionId: 'sess-abc-123',
    });

    expect(await repo.findSessionId('key-1')).toBe('sess-abc-123');
  });

  it('should overwrite an existing mapping without clearing chat metadata', async () => {
    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      sessionId: null,
      botName: 'main-bot',
      chatId: '1234',
      messageThreadId: 99,
    });

    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      sessionId: 'sess-new-456',
    });

    const row = await repo.findBySessionKey('key-1');
    expect(row?.sessionId).toBe('sess-new-456');
    expect(row?.botName).toBe('main-bot');
    expect(row?.chatId).toBe('1234');
    expect(row?.messageThreadId).toBe(99);
  });

  it('should delete a session mapping', async () => {
    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      sessionId: null,
      botName: 'main-bot',
      chatId: '1234',
    });

    await repo.deleteBySessionKey('key-1');

    expect(await repo.findBySessionKey('key-1')).toBeNull();
  });
});
