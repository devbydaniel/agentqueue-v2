import { FlowRunRepository } from './flow-run.repository.js';
import type { FlowRun } from './flow-run.repository.js';
import { RunRepository } from '../runs/run.repository.js';
import {
  getTestDb,
  truncateAll,
  closeTestDb,
} from '../../test/integration/db.js';
import type { DrizzleDb } from '../database/database.tokens.js';

describe('FlowRunRepository (integration)', () => {
  let repo: FlowRunRepository;
  let runRepo: RunRepository;
  let db: DrizzleDb;

  beforeAll(() => {
    db = getTestDb();
    repo = new FlowRunRepository(db);
    runRepo = new RunRepository(db);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe('create', () => {
    it('should generate unique IDs with status running', async () => {
      const run1 = await repo.create('factory', { task: 'build' });
      const run2 = await repo.create('factory', { task: 'test' });

      expect(run1.flowRunId).toBeDefined();
      expect(run2.flowRunId).toBeDefined();
      expect(run1.flowRunId).not.toBe(run2.flowRunId);
      expect(run1.status).toBe('running');
      expect(run2.status).toBe('running');
      expect(run1.flowName).toBe('factory');
      expect(run1.vars).toEqual({ task: 'build' });
      expect(run1.steps).toEqual([]);
      expect(run1.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('findById', () => {
    it('should return the run by ID', async () => {
      const run = await repo.create('factory', {});
      const found = await repo.findById(run.flowRunId);

      expect(found).not.toBeNull();
      expect(found!.flowRunId).toBe(run.flowRunId);
      expect(found!.flowName).toBe('factory');
      expect(found!.status).toBe('running');
    });

    it('should return null for unknown ID', async () => {
      expect(
        await repo.findById('00000000-0000-0000-0000-000000000000'),
      ).toBeNull();
    });

    it('should include steps ordered by stepIndex', async () => {
      const run = await repo.create('factory', {});

      run.steps.push(
        { agent: 'planner', vars: { v: '1' }, startedAt: new Date() },
        { agent: 'dev', vars: { v: '2' }, startedAt: new Date() },
      );
      await repo.save(run);

      const found = await repo.findById(run.flowRunId);
      expect(found!.steps).toHaveLength(2);
      expect(found!.steps[0].agent).toBe('planner');
      expect(found!.steps[1].agent).toBe('dev');
    });
  });

  describe('findByFlowName', () => {
    it('should return only runs for the given flow name', async () => {
      await repo.create('factory', {});
      await repo.create('bugfix', {});
      await repo.create('factory', {});

      const factoryRuns = await repo.findByFlowName('factory');
      expect(factoryRuns).toHaveLength(2);
      for (const run of factoryRuns) {
        expect(run.flowName).toBe('factory');
      }

      expect(await repo.findByFlowName('bugfix')).toHaveLength(1);
      expect(await repo.findByFlowName('unknown')).toHaveLength(0);
    });
  });

  describe('save', () => {
    it('should persist mutations to an existing run', async () => {
      const run = await repo.create('factory', {});

      run.status = 'done';
      run.message = 'All good';
      run.completedAt = new Date();
      await repo.save(run);

      const fetched = await repo.findById(run.flowRunId);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('done');
      expect(fetched!.message).toBe('All good');
      expect(fetched!.completedAt).toBeInstanceOf(Date);
      expect(fetched!.flowName).toBe('factory');
    });

    it('should persist a new run that was not created via create()', async () => {
      const now = new Date();
      const manualRun: FlowRun = {
        flowRunId: '00000000-0000-0000-0000-000000000001',
        flowName: 'factory',
        status: 'running',
        vars: {},
        steps: [],
        startedAt: now,
      };
      await repo.save(manualRun);

      const fetched = await repo.findById(manualRun.flowRunId);
      expect(fetched).not.toBeNull();
      expect(fetched!.flowName).toBe('factory');
    });

    it('should persist appended steps', async () => {
      const run = await repo.create('factory', {});

      run.steps.push({
        agent: 'dev',
        vars: { task: 'build' },
        startedAt: new Date(),
      });
      await repo.save(run);

      const fetched = await repo.findById(run.flowRunId);
      expect(fetched!.steps).toHaveLength(1);
      expect(fetched!.steps[0].agent).toBe('dev');
      expect(fetched!.steps[0].completedAt).toBeUndefined();
    });

    it('should persist step with runId', async () => {
      // Create a real run row so the FK is satisfied
      const agentRun = await runRepo.create({
        source: 'flow',
        repo: 'test-repo',
        prompt: 'test prompt',
      });

      const run = await repo.create('factory', {});

      run.steps.push({
        agent: 'dev',
        vars: {},
        startedAt: new Date(),
        completedAt: new Date(),
        success: true,
        runId: agentRun.id,
      });
      await repo.save(run);

      const fetched = await repo.findById(run.flowRunId);
      expect(fetched!.steps[0].runId).toBe(agentRun.id);
      expect(fetched!.steps[0].success).toBe(true);
    });

    it('should replace steps on each save (not append)', async () => {
      const run = await repo.create('factory', {});

      run.steps.push({
        agent: 'planner',
        vars: {},
        startedAt: new Date(),
      });
      await repo.save(run);

      // Mark the first step completed and add a second
      run.steps[0].completedAt = new Date();
      run.steps[0].success = true;
      run.steps.push({
        agent: 'dev',
        vars: {},
        startedAt: new Date(),
      });
      await repo.save(run);

      const fetched = await repo.findById(run.flowRunId);
      expect(fetched!.steps).toHaveLength(2);
      expect(fetched!.steps[0].agent).toBe('planner');
      expect(fetched!.steps[0].success).toBe(true);
      expect(fetched!.steps[1].agent).toBe('dev');
    });
  });

  describe('markRunningAsInterrupted', () => {
    it('should mark running flow runs as interrupted', async () => {
      const running = await repo.create('factory', {});
      const done = await repo.create('bugfix', {});
      done.status = 'done';
      done.completedAt = new Date();
      await repo.save(done);

      const result = await repo.markRunningAsInterrupted();

      expect(result).toHaveLength(1);
      expect(result[0].flowRunId).toBe(running.flowRunId);

      const fetched = await repo.findById(running.flowRunId);
      expect(fetched!.status).toBe('interrupted');
      expect(fetched!.message).toBe(
        'Process restarted while flow was in progress',
      );
      expect(fetched!.completedAt).toBeInstanceOf(Date);
    });

    it('should return empty array when no running flow runs exist', async () => {
      const result = await repo.markRunningAsInterrupted();
      expect(result).toEqual([]);
    });
  });
});
