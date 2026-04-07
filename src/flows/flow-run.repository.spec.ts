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

  describe('update', () => {
    it('should merge partial fields into the run', async () => {
      const run = await repository.create('factory', {});
      await repository.update(run.flowRunId, {
        status: 'done',
        message: 'All good',
        completedAt: new Date(),
      });

      const updated = await repository.findById(run.flowRunId);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('done');
      expect(updated!.message).toBe('All good');
      expect(updated!.completedAt).toBeInstanceOf(Date);
      // Original fields preserved
      expect(updated!.flowName).toBe('factory');
    });

    it('should no-op for unknown run ID', async () => {
      await expect(
        repository.update('nonexistent', { status: 'done' }),
      ).resolves.not.toThrow();
    });
  });

  describe('addStep / completeStep', () => {
    it('should add a step and complete it', async () => {
      const run = await repository.create('factory', {});
      const step = {
        agent: 'dev',
        vars: { task: 'build' },
        startedAt: new Date(),
      };

      await repository.addStep(run.flowRunId, step);
      const afterAdd = await repository.findById(run.flowRunId);
      expect(afterAdd!.steps).toHaveLength(1);
      expect(afterAdd!.steps[0].agent).toBe('dev');
      expect(afterAdd!.steps[0].completedAt).toBeUndefined();
      expect(afterAdd!.steps[0].success).toBeUndefined();

      await repository.completeStep(run.flowRunId, true);
      const afterComplete = await repository.findById(run.flowRunId);
      expect(afterComplete!.steps[0].completedAt).toBeInstanceOf(Date);
      expect(afterComplete!.steps[0].success).toBe(true);
    });

    it('should complete the last step when multiple exist', async () => {
      const run = await repository.create('factory', {});

      await repository.addStep(run.flowRunId, {
        agent: 'dev',
        vars: {},
        startedAt: new Date(),
      });
      await repository.completeStep(run.flowRunId, true);

      await repository.addStep(run.flowRunId, {
        agent: 'qa',
        vars: {},
        startedAt: new Date(),
      });
      await repository.completeStep(run.flowRunId, false);

      const final = await repository.findById(run.flowRunId);
      expect(final!.steps[0].success).toBe(true);
      expect(final!.steps[1].success).toBe(false);
    });

    it('should no-op for unknown run ID', async () => {
      await expect(
        repository.addStep('nonexistent', {
          agent: 'dev',
          vars: {},
          startedAt: new Date(),
        }),
      ).resolves.not.toThrow();
      await expect(
        repository.completeStep('nonexistent', true),
      ).resolves.not.toThrow();
    });
  });
});
