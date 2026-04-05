import { FlowRegistryService } from './flow-registry.service.js';

describe('FlowRegistryService', () => {
  let service: FlowRegistryService;

  beforeEach(() => {
    service = new FlowRegistryService();
  });

  describe('create', () => {
    it('should generate unique IDs with status running', () => {
      const run1 = service.create('factory', { task: 'build' });
      const run2 = service.create('factory', { task: 'test' });

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

  describe('get', () => {
    it('should return the run by ID', () => {
      const run = service.create('factory', {});
      expect(service.get(run.flowRunId)).toBe(run);
    });

    it('should return undefined for unknown ID', () => {
      expect(service.get('nonexistent')).toBeUndefined();
    });
  });

  describe('listByFlow', () => {
    it('should return only runs for the given flow name', () => {
      service.create('factory', {});
      service.create('bugfix', {});
      service.create('factory', {});

      const factoryRuns = service.listByFlow('factory');
      expect(factoryRuns).toHaveLength(2);
      for (const run of factoryRuns) {
        expect(run.flowName).toBe('factory');
      }

      expect(service.listByFlow('bugfix')).toHaveLength(1);
      expect(service.listByFlow('unknown')).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('should merge partial fields into the run', () => {
      const run = service.create('factory', {});
      service.update(run.flowRunId, {
        status: 'done',
        message: 'All good',
        completedAt: new Date(),
      });

      const updated = service.get(run.flowRunId)!;
      expect(updated.status).toBe('done');
      expect(updated.message).toBe('All good');
      expect(updated.completedAt).toBeInstanceOf(Date);
      // Original fields preserved
      expect(updated.flowName).toBe('factory');
    });

    it('should no-op for unknown run ID', () => {
      expect(() =>
        service.update('nonexistent', { status: 'done' }),
      ).not.toThrow();
    });
  });

  describe('addStep / completeStep', () => {
    it('should add a step and complete it', () => {
      const run = service.create('factory', {});
      const step = {
        agent: 'dev',
        vars: { task: 'build' },
        startedAt: new Date(),
      };

      service.addStep(run.flowRunId, step);
      expect(run.steps).toHaveLength(1);
      expect(run.steps[0].agent).toBe('dev');
      expect(run.steps[0].completedAt).toBeUndefined();
      expect(run.steps[0].success).toBeUndefined();

      service.completeStep(run.flowRunId, true);
      expect(run.steps[0].completedAt).toBeInstanceOf(Date);
      expect(run.steps[0].success).toBe(true);
    });

    it('should complete the last step when multiple exist', () => {
      const run = service.create('factory', {});

      service.addStep(run.flowRunId, {
        agent: 'dev',
        vars: {},
        startedAt: new Date(),
      });
      service.completeStep(run.flowRunId, true);

      service.addStep(run.flowRunId, {
        agent: 'qa',
        vars: {},
        startedAt: new Date(),
      });
      service.completeStep(run.flowRunId, false);

      expect(run.steps[0].success).toBe(true);
      expect(run.steps[1].success).toBe(false);
    });

    it('should no-op for unknown run ID', () => {
      expect(() =>
        service.addStep('nonexistent', {
          agent: 'dev',
          vars: {},
          startedAt: new Date(),
        }),
      ).not.toThrow();
      expect(() => service.completeStep('nonexistent', true)).not.toThrow();
    });
  });

  describe('abort', () => {
    it('should signal the abort controller and return true', () => {
      const run = service.create('factory', {});
      const controller = new AbortController();
      service.trackAbortController(run.flowRunId, controller);

      expect(controller.signal.aborted).toBe(false);
      const result = service.abort(run.flowRunId);
      expect(result).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should return false for unknown run ID', () => {
      expect(service.abort('nonexistent')).toBe(false);
    });

    it('should return false after already aborted (controller removed)', () => {
      const run = service.create('factory', {});
      const controller = new AbortController();
      service.trackAbortController(run.flowRunId, controller);

      service.abort(run.flowRunId);
      expect(service.abort(run.flowRunId)).toBe(false);
    });
  });
});
