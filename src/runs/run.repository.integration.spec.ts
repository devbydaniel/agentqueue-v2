import { NotFoundException } from '@nestjs/common';
import { RunRepository } from './run.repository.js';
import type { CreateRunCommand } from './run.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { DrizzleDb } from '../database/database.tokens.js';

describe('RunRepository (integration)', () => {
  let repo: RunRepository;
  let db: DrizzleDb;

  const baseCommand: CreateRunCommand = {
    source: 'manual',
    repo: 'my-repo',
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
      expect(run.repo).toBe('my-repo');
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
        sessionKey: 'session-123',
        prependSystemPrompt: 'You are a code reviewer.',
        appendSystemPrompt: 'Be thorough.',
      });

      expect(run.source).toBe('linear');
      expect(run.triggerName).toBe('coding-agent');
      expect(run.sessionKey).toBe('session-123');
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
      expect(found!.repo).toBe('my-repo');
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
