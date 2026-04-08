import { RunEventRepository } from './run-event.repository.js';
import { RunRepository } from './run.repository.js';
import type { CreateRunCommand } from './run.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { DrizzleDb } from '../database/database.tokens.js';

describe('RunEventRepository (integration)', () => {
  let eventRepo: RunEventRepository;
  let runRepo: RunRepository;
  let db: DrizzleDb;
  let runId: string;

  const baseCommand: CreateRunCommand = {
    source: 'manual',
    repo: 'my-repo',
    prompt: 'Fix the failing tests',
  };

  beforeAll(() => {
    db = getTestDb();
    eventRepo = new RunEventRepository(db);
    runRepo = new RunRepository(db);
  });

  beforeEach(async () => {
    await truncateAll();
    const run = await runRepo.create(baseCommand);
    runId = run.id;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('append', () => {
    it('should insert an event for a run', async () => {
      await eventRepo.append(runId, 'agent_start', { some: 'data' });

      const events = await eventRepo.findByRunId(runId);
      expect(events).toHaveLength(1);
      expect(events[0].runId).toBe(runId);
      expect(events[0].type).toBe('agent_start');
      expect(events[0].payload).toEqual({ some: 'data' });
      expect(events[0].createdAt).toBeInstanceOf(Date);
    });

    it('should handle null payload', async () => {
      await eventRepo.append(runId, 'turn_start', null);

      const events = await eventRepo.findByRunId(runId);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toBeNull();
    });

    it('should append multiple events in order', async () => {
      await eventRepo.append(runId, 'agent_start', {});
      await eventRepo.append(runId, 'turn_start', {});
      await eventRepo.append(runId, 'turn_end', { toolResults: 2 });

      const events = await eventRepo.findByRunId(runId);
      expect(events).toHaveLength(3);
      expect(events.map((e) => e.type)).toEqual([
        'agent_start',
        'turn_start',
        'turn_end',
      ]);
    });
  });

  describe('findByRunId', () => {
    it('should return empty array when no events exist', async () => {
      const events = await eventRepo.findByRunId(runId);
      expect(events).toEqual([]);
    });

    it('should respect limit', async () => {
      for (let i = 0; i < 5; i++) {
        await eventRepo.append(runId, `event_${i}`, { index: i });
      }

      const events = await eventRepo.findByRunId(runId, { limit: 3 });
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('event_0');
    });

    it('should respect offset', async () => {
      for (let i = 0; i < 5; i++) {
        await eventRepo.append(runId, `event_${i}`, { index: i });
      }

      const events = await eventRepo.findByRunId(runId, {
        limit: 2,
        offset: 2,
      });
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('event_2');
      expect(events[1].type).toBe('event_3');
    });

    it('should only return events for the specified run', async () => {
      const otherRun = await runRepo.create({
        ...baseCommand,
        prompt: 'Other run',
      });

      await eventRepo.append(runId, 'agent_start', {});
      await eventRepo.append(otherRun.id, 'agent_start', {});

      const events = await eventRepo.findByRunId(runId);
      expect(events).toHaveLength(1);
      expect(events[0].runId).toBe(runId);
    });
  });
});
