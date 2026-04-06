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
});
