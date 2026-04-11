import { ActiveSessionTrackerService } from './active-session-tracker.service.js';

describe('ActiveSessionTrackerService', () => {
  let tracker: ActiveSessionTrackerService;

  beforeEach(() => {
    tracker = new ActiveSessionTrackerService();
  });

  it('should abort a tracked controller and return true', () => {
    const controller = new AbortController();
    tracker.track('key-1', controller);

    const result = tracker.abort('key-1');

    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('should return false when aborting an unknown session', () => {
    const result = tracker.abort('unknown');

    expect(result).toBe(false);
  });

  it('should not abort after untracking', () => {
    const controller = new AbortController();
    tracker.track('key-1', controller);
    tracker.untrack('key-1');

    const result = tracker.abort('key-1');

    expect(result).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  });

  describe('dual-indexing', () => {
    it('should track by both externalSessionId and runId', () => {
      const controller = new AbortController();
      tracker.track('session-1', controller, 'run-abc');

      const resultBySession = tracker.abort('session-1');
      expect(resultBySession).toBe(true);
      expect(controller.signal.aborted).toBe(true);

      // RunId key should also work (controller is already aborted, but key resolves)
      const resultByRun = tracker.abort('run-abc');
      expect(resultByRun).toBe(true);
    });

    it('should untrack both keys when runId is provided', () => {
      const controller = new AbortController();
      tracker.track('session-1', controller, 'run-abc');
      tracker.untrack('session-1', 'run-abc');

      const resultBySession = tracker.abort('session-1');
      expect(resultBySession).toBe(false);

      const resultByRun = tracker.abort('run-abc');
      expect(resultByRun).toBe(false);
    });

    it('should allow abort by runId alone', () => {
      const controller = new AbortController();
      tracker.track('session-1', controller, 'run-abc');

      const result = tracker.abort('run-abc');

      expect(result).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should not create runId entry when runId is not provided', () => {
      const controller = new AbortController();
      tracker.track('session-1', controller);

      const result = tracker.abort('session-1');
      expect(result).toBe(true);
    });
  });

  describe('abortAll', () => {
    it('should abort all tracked controllers and clear the map', () => {
      const controller1 = new AbortController();
      const controller2 = new AbortController();
      tracker.track('key-1', controller1);
      tracker.track('key-2', controller2);

      const count = tracker.abortAll();

      expect(count).toBe(2);
      expect(controller1.signal.aborted).toBe(true);
      expect(controller2.signal.aborted).toBe(true);

      // After abortAll, no sessions should remain
      const result = tracker.abort('key-1');
      expect(result).toBe(false);
    });

    it('should deduplicate controllers tracked under multiple keys', () => {
      const controller = new AbortController();
      tracker.track('session-1', controller, 'run-abc');

      const count = tracker.abortAll();

      expect(count).toBe(1); // Only one unique controller
      expect(controller.signal.aborted).toBe(true);
    });

    it('should return 0 when no sessions are tracked', () => {
      const count = tracker.abortAll();
      expect(count).toBe(0);
    });
  });
});
