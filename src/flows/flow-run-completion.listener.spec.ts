import { FlowRunCompletionListener } from './flow-run-completion.listener.js';
import type { RunRepository } from '../runs/run.repository.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { Run } from '../database/runs.schema.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-123',
    source: 'flow',
    triggerName: null,
    parentFlowRunId: 'flow-run-1',
    repo: 'core',
    prompt: 'do something',
    promptPreview: 'do something',
    status: 'succeeded',
    attemptsMade: 1,
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: null,
    sessionKey: null,
    prependSystemPrompt: null,
    appendSystemPrompt: null,
    queueJobId: 'job-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Mock pg module to control the Client constructor
jest.mock('pg', () => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const mockClient = {
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue(undefined),
    on: jest
      .fn()
      .mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime init
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
      }),
    end: jest.fn().mockResolvedValue(undefined),
    __emit: (event: string, ...args: unknown[]) => {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
    __handlers: handlers,
  };
  return {
    __esModule: true,
    default: { Client: jest.fn(() => mockClient), Pool: jest.fn() },
    Client: jest.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgMock = require('pg') as {
  __mockClient: {
    connect: jest.Mock;
    query: jest.Mock;
    on: jest.Mock;
    end: jest.Mock;
    __emit: (event: string, ...args: unknown[]) => void;
    __handlers: Record<string, ((...args: unknown[]) => void)[]>;
  };
};

describe('FlowRunCompletionListener', () => {
  let listener: FlowRunCompletionListener;
  let mockRunRepository: jest.Mocked<Pick<RunRepository, 'findById'>>;
  let mockClient: typeof pgMock.__mockClient;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockClient = pgMock.__mockClient;
    // Clear event handlers
    for (const key of Object.keys(mockClient.__handlers)) {
      delete mockClient.__handlers[key];
    }

    mockRunRepository = {
      findById: jest.fn(),
    };

    const mockConfig = {
      databaseUrl: 'postgresql://test:test@localhost:5432/test',
    } as unknown as AppConfigService;

    listener = new FlowRunCompletionListener(
      mockConfig,
      mockRunRepository as unknown as RunRepository,
    );

    await listener.onModuleInit();
  });

  function simulateNotification(runId: string): void {
    mockClient.__emit('notification', {
      channel: 'run_completed',
      payload: runId,
    });
  }

  it('should resolve when a notification arrives for a waited run', async () => {
    const run = makeRun({ id: 'run-abc', status: 'succeeded' });
    mockRunRepository.findById.mockResolvedValue(run);

    const promise = listener.waitFor('run-abc', 5000);
    simulateNotification('run-abc');

    const result = await promise;
    expect(result).toEqual({
      status: 'succeeded',
      errorMessage: undefined,
      runId: 'run-abc',
    });
    expect(mockRunRepository.findById).toHaveBeenCalledWith('run-abc');
  });

  it('should resolve with errored status and error message', async () => {
    const run = makeRun({
      id: 'run-err',
      status: 'errored',
      errorMessage: 'boom',
    });
    mockRunRepository.findById.mockResolvedValue(run);

    const promise = listener.waitFor('run-err', 5000);
    simulateNotification('run-err');

    const result = await promise;
    expect(result).toEqual({
      status: 'errored',
      errorMessage: 'boom',
      runId: 'run-err',
    });
  });

  it('should handle multiple concurrent waiters for different runIds', async () => {
    const run1 = makeRun({ id: 'run-1', status: 'succeeded' });
    const run2 = makeRun({
      id: 'run-2',
      status: 'errored',
      errorMessage: 'failed',
    });
    mockRunRepository.findById.mockImplementation(async (id: string) => {
      if (id === 'run-1') return run1;
      if (id === 'run-2') return run2;
      return null;
    });

    const p1 = listener.waitFor('run-1', 5000);
    const p2 = listener.waitFor('run-2', 5000);

    simulateNotification('run-2');
    simulateNotification('run-1');

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.runId).toBe('run-1');
    expect(r2.runId).toBe('run-2');
  });

  it('should reject on timeout', async () => {
    jest.useFakeTimers();

    const promise = listener.waitFor('run-slow', 1000);
    jest.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow('Timed out waiting for run run-slow');

    jest.useRealTimers();
  });

  it('should ignore notifications for unknown runIds', () => {
    // No waiter registered — should not throw
    simulateNotification('unknown-run');
    expect(mockRunRepository.findById).not.toHaveBeenCalled();
  });

  it('should reject waiter when run is not found after notification', async () => {
    mockRunRepository.findById.mockResolvedValue(null);

    const promise = listener.waitFor('run-ghost', 5000);
    simulateNotification('run-ghost');

    await expect(promise).rejects.toThrow(
      'Run run-ghost not found after notification',
    );
  });

  it('should reject all waiters on shutdown', async () => {
    const p1 = listener.waitFor('run-1', 60000);
    const p2 = listener.waitFor('run-2', 60000);

    await listener.onApplicationShutdown();

    await expect(p1).rejects.toThrow('Application shutting down');
    await expect(p2).rejects.toThrow('Application shutting down');
  });
});
