import { LinearSessionRepository } from './linear-session.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { DrizzleDb } from '../database/database.tokens.js';

describe('LinearSessionRepository (integration)', () => {
  let repo: LinearSessionRepository;
  let db: DrizzleDb;

  beforeAll(() => {
    db = getTestDb();
    repo = new LinearSessionRepository(db);
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
    await repo.saveFilePath('key-1', '/sessions/abc.jsonl');

    expect(await repo.findFilePath('key-1')).toBe('/sessions/abc.jsonl');
  });

  it('should overwrite an existing mapping', async () => {
    await repo.saveFilePath('key-1', '/sessions/old.jsonl');
    await repo.saveFilePath('key-1', '/sessions/new.jsonl');

    expect(await repo.findFilePath('key-1')).toBe('/sessions/new.jsonl');
  });

  it('should store multiple keys independently', async () => {
    await repo.saveFilePath('key-1', '/sessions/a.jsonl');
    await repo.saveFilePath('key-2', '/sessions/b.jsonl');

    expect(await repo.findFilePath('key-1')).toBe('/sessions/a.jsonl');
    expect(await repo.findFilePath('key-2')).toBe('/sessions/b.jsonl');
  });
});
