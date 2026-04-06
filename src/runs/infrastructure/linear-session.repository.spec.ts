import { LinearSessionRepository } from './linear-session.repository.js';

describe('LinearSessionRepository', () => {
  let repository: LinearSessionRepository;

  beforeEach(() => {
    repository = new LinearSessionRepository();
  });

  it('should return null for unknown session key', async () => {
    expect(await repository.findFilePath('unknown')).toBeNull();
  });

  it('should store and retrieve a session file path', async () => {
    await repository.saveFilePath('key-1', '/sessions/abc.jsonl');

    expect(await repository.findFilePath('key-1')).toBe('/sessions/abc.jsonl');
  });

  it('should overwrite an existing mapping', async () => {
    await repository.saveFilePath('key-1', '/sessions/old.jsonl');
    await repository.saveFilePath('key-1', '/sessions/new.jsonl');

    expect(await repository.findFilePath('key-1')).toBe('/sessions/new.jsonl');
  });
});
