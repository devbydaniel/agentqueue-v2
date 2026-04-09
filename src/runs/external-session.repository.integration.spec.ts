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
    expect(await repo.findFilePath('unknown')).toBeNull();
  });

  it('should store and retrieve a session file path', async () => {
    await repo.upsertSession({
      provider: 'linear',
      sessionKey: 'key-1',
      filePath: '/sessions/abc.jsonl',
    });

    expect(await repo.findFilePath('key-1')).toBe('/sessions/abc.jsonl');
  });

  it('should overwrite an existing mapping without clearing chat metadata', async () => {
    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      filePath: null,
      botName: 'main-bot',
      chatId: '1234',
      messageThreadId: 99,
    });

    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      filePath: '/sessions/new.jsonl',
    });

    const row = await repo.findBySessionKey('key-1');
    expect(row?.filePath).toBe('/sessions/new.jsonl');
    expect(row?.botName).toBe('main-bot');
    expect(row?.chatId).toBe('1234');
    expect(row?.messageThreadId).toBe(99);
  });

  it('should delete a session mapping', async () => {
    await repo.upsertSession({
      provider: 'telegram',
      sessionKey: 'key-1',
      filePath: null,
      botName: 'main-bot',
      chatId: '1234',
    });

    await repo.deleteBySessionKey('key-1');

    expect(await repo.findBySessionKey('key-1')).toBeNull();
  });
});
