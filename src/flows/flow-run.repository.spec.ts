import { FlowRunRepository } from './flow-run.repository.js';

describe('FlowRunRepository', () => {
  let repository: FlowRunRepository;

  beforeEach(() => {
    repository = new FlowRunRepository();
  });

  describe('create', () => {
    it('should generate unique IDs with status running', async () => {
      const run1 = await repository.create('factory', { task: 'build' });
      const run2 = await repository.create('factory', { task: 'test' });

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
      const run = await repository.create('factory', {});
      expect(await repository.findById(run.flowRunId)).toEqual(run);
    });

    it('should return null for unknown ID', async () => {
      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findByFlowName', () => {
    it('should return only runs for the given flow name', async () => {
      await repository.create('factory', {});
      await repository.create('bugfix', {});
      await repository.create('factory', {});

      const factoryRuns = await repository.findByFlowName('factory');
      expect(factoryRuns).toHaveLength(2);
      for (const run of factoryRuns) {
        expect(run.flowName).toBe('factory');
      }

      expect(await repository.findByFlowName('bugfix')).toHaveLength(1);
      expect(await repository.findByFlowName('unknown')).toHaveLength(0);
    });
  });

  describe('save', () => {
    it('should persist mutations to an existing run', async () => {
      const run = await repository.create('factory', {});

      run.status = 'done';
      run.message = 'All good';
      run.completedAt = new Date();
      await repository.save(run);

      const fetched = await repository.findById(run.flowRunId);
      expect(fetched).not.toBeNull();
      expect(fetched!.status).toBe('done');
      expect(fetched!.message).toBe('All good');
      expect(fetched!.completedAt).toBeInstanceOf(Date);
      // Original fields preserved
      expect(fetched!.flowName).toBe('factory');
    });

    it('should persist a new run that was not created via create()', async () => {
      // The save API should be capable of inserting too — useful when
      // reconstructing a run from a queue payload, etc.
      await repository.save({
        flowRunId: 'manual-1',
        flowName: 'factory',
        status: 'running',
        vars: {},
        steps: [],
        startedAt: new Date(),
      });

      const fetched = await repository.findById('manual-1');
      expect(fetched).not.toBeNull();
      expect(fetched!.flowName).toBe('factory');
    });

    it('should persist appended steps', async () => {
      const run = await repository.create('factory', {});

      run.steps.push({
        agent: 'dev',
        vars: { task: 'build' },
        startedAt: new Date(),
      });
      await repository.save(run);

      const fetched = await repository.findById(run.flowRunId);
      expect(fetched!.steps).toHaveLength(1);
      expect(fetched!.steps[0].agent).toBe('dev');
      expect(fetched!.steps[0].completedAt).toBeUndefined();
    });
  });
});
