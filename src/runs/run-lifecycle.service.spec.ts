import { RunLifecycleService } from './run-lifecycle.service.js';
import type { RunRepository } from './run.repository.js';
import type { ExternalSessionRepository } from './external-session.repository.js';
import type { RunCompletionNotifier } from './run-completion.notifier.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Run } from '../database/runs.schema.js';

const HOUR_MS = 60 * 60 * 1000;

describe('RunLifecycleService', () => {
  const service = new RunLifecycleService(
    {} as RunRepository,
    {} as ExternalSessionRepository,
    {} as RunCompletionNotifier,
    { runTimeoutMs: 4 * HOUR_MS } as AppConfigService,
  );
  const runWith = (timeoutMs: number | null) =>
    ({ id: 'run-1', timeoutMs }) as Run;

  describe('resolveTimeoutMs', () => {
    it("uses the run's own timeout", () => {
      expect(service.resolveTimeoutMs(runWith(20 * HOUR_MS))).toBe(
        20 * HOUR_MS,
      );
    });

    it('falls back to the configured default', () => {
      expect(service.resolveTimeoutMs(runWith(null))).toBe(4 * HOUR_MS);
    });

    it('caps timeouts at 23 hours so the queue job never expires first', () => {
      expect(service.resolveTimeoutMs(runWith(48 * HOUR_MS))).toBe(
        23 * HOUR_MS,
      );
    });
  });
});
