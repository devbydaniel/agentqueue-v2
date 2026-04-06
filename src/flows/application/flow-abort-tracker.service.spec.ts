import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';

describe('FlowAbortTrackerService', () => {
  let tracker: FlowAbortTrackerService;

  beforeEach(() => {
    tracker = new FlowAbortTrackerService();
  });

  it('should signal the abort controller and return true', () => {
    const controller = new AbortController();
    tracker.track('run-1', controller);

    expect(controller.signal.aborted).toBe(false);
    const result = tracker.abort('run-1');
    expect(result).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it('should return false for unknown run ID', () => {
    expect(tracker.abort('nonexistent')).toBe(false);
  });

  it('should return false after already aborted (controller removed)', () => {
    const controller = new AbortController();
    tracker.track('run-1', controller);

    tracker.abort('run-1');
    expect(tracker.abort('run-1')).toBe(false);
  });
});
