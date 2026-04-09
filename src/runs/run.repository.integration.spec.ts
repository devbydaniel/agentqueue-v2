import { NotFoundException } from '@nestjs/common';
import { RunRepository } from './run.repository.js';
import type { CreateRunCommand } from './run.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { PgPool } from '../database/database.tokens.js';

describe('RunRepository (integration)', () => {
  let repo: RunRepository;
  let db: PgPool;

  const baseCommand: CreateRunCommand = {
    source: 'manual',
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
    cwd: '/tmp/my-repo',
    prompt: 'Fix the failing tests',
  };

  beforeAll(() => {
    db = getTestDb();
    // Create repository with the test DB injected
    repo = new RunRepository(db);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('create', () => {
    it('should insert a run and return it with an id', async () => {
      const run = await repo.create(baseCommand);

      expect(run.id).toBeDefined();
      expect(run.source).toBe('manual');
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
      expect(run.cwd).toBe('/tmp/my-repo');
      expect(run.prompt).toBe('Fix the failing tests');
      expect(run.promptPreview).toBe('Fix the failing tests');
      expect(run.status).toBe('waiting');
      expect(run.attemptsMade).toBe(0);
      expect(run.createdAt).toBeInstanceOf(Date);
      expect(run.updatedAt).toBeInstanceOf(Date);
    });

    it('should set optional fields when provided', async () => {
      const run = await repo.create({
        ...baseCommand,
        source: 'linear',
        triggerName: 'coding-agent',
        externalSessionId: 'session-123',
        prependSystemPrompt: 'You are a code reviewer.',
        appendSystemPrompt: 'Be thorough.',
      });

      expect(run.source).toBe('linear');
      expect(run.triggerName).toBe('coding-agent');
      expect(run.externalSessionId).toBe('session-123');
      expect(run.prependSystemPrompt).toBe('You are a code reviewer.');
      expect(run.appendSystemPrompt).toBe('Be thorough.');
    });

    it('should truncate promptPreview to 500 chars', async () => {
      const longPrompt = 'A'.repeat(600);
      const run = await repo.create({ ...baseCommand, prompt: longPrompt });

      expect(run.prompt).toBe(longPrompt);
      expect(run.promptPreview).toBe('A'.repeat(500));
    });
  });

  describe('findById', () => {
    it('should return the run when it exists', async () => {
      const created = await repo.create(baseCommand);
      const found = await repo.findById(created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
      expect(found!.cwd).toBe('/tmp/my-repo');
    });

    it('should return null when the run does not exist', async () => {
      const found = await repo.findById('00000000-0000-0000-0000-000000000000');
      expect(found).toBeNull();
    });
  });

  describe('save', () => {
    it('should update run fields', async () => {
      const created = await repo.create(baseCommand);
      const now = new Date();

      created.status = 'running';
      created.attemptsMade = 1;
      created.startedAt = now;
      await repo.save(created);

      const updated = await repo.findById(created.id);
      expect(updated!.status).toBe('running');
      expect(updated!.attemptsMade).toBe(1);
      expect(updated!.startedAt).toEqual(now);
      // updatedAt should have changed (set by save())
      expect(updated!.updatedAt).toBeDefined();
    });

    it('should throw NotFoundException when run does not exist', async () => {
      const fakeRun = {
        id: '00000000-0000-0000-0000-000000000000',
        status: 'running' as const,
        attemptsMade: 1,
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        queueJobId: null,
      };

      await expect(repo.save(fakeRun as any)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should update terminal status with error message', async () => {
      const created = await repo.create(baseCommand);
      const now = new Date();

      created.status = 'errored';
      created.errorMessage = 'Something went wrong';
      created.completedAt = now;
      await repo.save(created);

      const updated = await repo.findById(created.id);
      expect(updated!.status).toBe('errored');
      expect(updated!.errorMessage).toBe('Something went wrong');
      expect(updated!.completedAt).toEqual(now);
    });
  });

  describe('findMany', () => {
    it('should return runs ordered by createdAt desc', async () => {
      await repo.create({ ...baseCommand, prompt: 'first' });
      const run2 = await repo.create({ ...baseCommand, prompt: 'second' });

      const results = await repo.findMany();

      expect(results).toHaveLength(2);
      // Most recent first
      expect(results[0].id).toBe(run2.id);
    });

    it('should filter by status', async () => {
      await repo.create(baseCommand);
      const run2 = await repo.create(baseCommand);
      run2.status = 'running';
      run2.startedAt = new Date();
      run2.attemptsMade = 1;
      await repo.save(run2);

      const results = await repo.findMany({ status: 'running' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(run2.id);
    });

    it('should filter by source', async () => {
      await repo.create({ ...baseCommand, source: 'manual' });
      const cronRun = await repo.create({ ...baseCommand, source: 'cron' });

      const results = await repo.findMany({ source: 'cron' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(cronRun.id);
    });

    it('should filter by cwd', async () => {
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
      await repo.create({ ...baseCommand, cwd: '/tmp/other-repo' });
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
      const myRun = await repo.create({ ...baseCommand, cwd: '/tmp/my-repo' });

      // eslint-disable-next-line sonarjs/publicly-writable-directories -- test-only placeholder path
      const results = await repo.findMany({ cwd: '/tmp/my-repo' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(myRun.id);
    });

    it('should filter by trigger name', async () => {
      await repo.create({ ...baseCommand, triggerName: 'other-trigger' });
      const myRun = await repo.create({
        ...baseCommand,
        triggerName: 'my-trigger',
      });

      const results = await repo.findMany({ trigger: 'my-trigger' });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(myRun.id);
    });

    it('should respect limit and offset', async () => {
      await repo.create({ ...baseCommand, prompt: 'first' });
      await repo.create({ ...baseCommand, prompt: 'second' });
      await repo.create({ ...baseCommand, prompt: 'third' });

      const results = await repo.findMany({ limit: 1, offset: 1 });

      expect(results).toHaveLength(1);
      // Offset 1 from desc order = second run
      expect(results[0].prompt).toBe('second');
    });

    it('should combine multiple filters', async () => {
      const run = await repo.create({
        ...baseCommand,
        source: 'cron',
        triggerName: 'daily',
      });
      run.status = 'succeeded';
      run.completedAt = new Date();
      await repo.save(run);

      await repo.create({ ...baseCommand, source: 'cron' }); // waiting, no match
      await repo.create({ ...baseCommand, source: 'manual' }); // wrong source

      const results = await repo.findMany({
        source: 'cron',
        status: 'succeeded',
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(run.id);
    });

    it('should return empty array when no runs match', async () => {
      const results = await repo.findMany({ status: 'running' });
      expect(results).toEqual([]);
    });
  });

  describe('markWaitingQueueJob', () => {
    it('should throw NotFoundException when run does not exist', async () => {
      await expect(
        repo.markWaitingQueueJob(
          '00000000-0000-0000-0000-000000000000',
          'job-xyz',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should store the queue job id on the run', async () => {
      const created = await repo.create(baseCommand);

      await repo.markWaitingQueueJob(created.id, 'job-abc-123');

      const updated = await repo.findById(created.id);
      expect(updated!.queueJobId).toBe('job-abc-123');
    });
  });
});
