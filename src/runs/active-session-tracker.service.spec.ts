import { ActiveSessionTrackerService } from './active-session-tracker.service.js';

describe('ActiveSessionTrackerService', () => {
  let tracker: ActiveSessionTrackerService;

  beforeEach(() => {
    tracker = new ActiveSessionTrackerService();
  });

  it('should abort a tracked session and return true', async () => {
    const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
    tracker.track('key-1', mockSession as never);

    const result = await tracker.abort('key-1');

    expect(result).toBe(true);
    expect(mockSession.abort).toHaveBeenCalled();
  });

  it('should return false when aborting an unknown session', async () => {
    const result = await tracker.abort('unknown');

    expect(result).toBe(false);
  });

  it('should not abort after untracking', async () => {
    const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
    tracker.track('key-1', mockSession as never);
    tracker.untrack('key-1');

    const result = await tracker.abort('key-1');

    expect(result).toBe(false);
    expect(mockSession.abort).not.toHaveBeenCalled();
  });

  describe('dual-indexing', () => {
    it('should track by both sessionKey and runId', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      tracker.track('session-1', mockSession as never, 'run-abc');

      // Both keys should resolve to the same session
      const resultBySession = await tracker.abort('session-1');
      expect(resultBySession).toBe(true);

      // Same session reference, so abort was already called
      expect(mockSession.abort).toHaveBeenCalledTimes(1);

      // RunId key should also work
      const resultByRun = await tracker.abort('run-abc');
      expect(resultByRun).toBe(true);
      expect(mockSession.abort).toHaveBeenCalledTimes(2);
    });

    it('should untrack both keys when runId is provided', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      tracker.track('session-1', mockSession as never, 'run-abc');
      tracker.untrack('session-1', 'run-abc');

      const resultBySession = await tracker.abort('session-1');
      expect(resultBySession).toBe(false);

      const resultByRun = await tracker.abort('run-abc');
      expect(resultByRun).toBe(false);
    });

    it('should allow abort by runId alone', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      tracker.track('session-1', mockSession as never, 'run-abc');

      const result = await tracker.abort('run-abc');

      expect(result).toBe(true);
      expect(mockSession.abort).toHaveBeenCalled();
    });

    it('should not create runId entry when runId is not provided', async () => {
      const mockSession = { abort: jest.fn().mockResolvedValue(undefined) };
      tracker.track('session-1', mockSession as never);

      const result = await tracker.abort('session-1');
      expect(result).toBe(true);
    });
  });
});
