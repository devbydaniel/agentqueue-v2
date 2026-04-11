import { Test } from '@nestjs/testing';
import { RunQueueWorkerService } from './run-queue-worker.service.js';
import { RUNS_QUEUE_NAME } from './runs.constants.js';
import { BOSS } from '../queue/queue.tokens.js';
import { AppConfigService } from '../config/app-config.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';

describe('RunQueueWorkerService', () => {
  let service: RunQueueWorkerService;
  let mockBoss: { createQueue: jest.Mock; work: jest.Mock };
  let mockProcessorService: { processRun: jest.Mock };
  let mockSessionTracker: { abortAll: jest.Mock };
  let registeredHandler: (
    jobs: Array<{ id: string; data: { runId: string } }>,
  ) => Promise<void>;

  beforeEach(async () => {
    mockBoss = {
      createQueue: jest.fn().mockResolvedValue(undefined),
      work: jest.fn().mockImplementation((_queue, _opts, handler) => {
        registeredHandler = handler;
      }),
    };

    mockProcessorService = {
      processRun: jest.fn().mockResolvedValue(undefined),
    };

    mockSessionTracker = {
      abortAll: jest.fn().mockReturnValue(0),
    };

    const module = await Test.createTestingModule({
      providers: [
        RunQueueWorkerService,
        { provide: BOSS, useValue: mockBoss },
        {
          provide: AppConfigService,
          useValue: { queueConcurrency: 3 },
        },
        {
          provide: RunProcessorService,
          useValue: mockProcessorService,
        },
        {
          provide: ActiveSessionTrackerService,
          useValue: mockSessionTracker,
        },
      ],
    }).compile();

    service = module.get(RunQueueWorkerService);
  });

  it('should register a handler on the runs queue during onModuleInit', async () => {
    await service.onModuleInit();

    expect(mockBoss.work).toHaveBeenCalledWith(
      RUNS_QUEUE_NAME,
      { localConcurrency: 3 },
      expect.any(Function),
    );
  });

  it('should delegate to processRun when a job arrives', async () => {
    await service.onModuleInit();

    await registeredHandler([{ id: 'job-1', data: { runId: 'run-abc' } }]);

    expect(mockProcessorService.processRun).toHaveBeenCalledWith('run-abc');
  });

  it('should process multiple jobs in a batch sequentially', async () => {
    await service.onModuleInit();

    await registeredHandler([
      { id: 'job-1', data: { runId: 'run-1' } },
      { id: 'job-2', data: { runId: 'run-2' } },
    ]);

    expect(mockProcessorService.processRun).toHaveBeenCalledTimes(2);
    expect(mockProcessorService.processRun).toHaveBeenNthCalledWith(1, 'run-1');
    expect(mockProcessorService.processRun).toHaveBeenNthCalledWith(2, 'run-2');
  });

  it('should catch errors from processRun and continue processing remaining jobs', async () => {
    await service.onModuleInit();
    mockProcessorService.processRun
      .mockRejectedValueOnce(new Error('processing failed'))
      .mockResolvedValueOnce(undefined);

    // Should not throw — errors are caught per-job
    await registeredHandler([
      { id: 'job-1', data: { runId: 'run-fail' } },
      { id: 'job-2', data: { runId: 'run-ok' } },
    ]);

    expect(mockProcessorService.processRun).toHaveBeenCalledTimes(2);
    expect(mockProcessorService.processRun).toHaveBeenNthCalledWith(
      1,
      'run-fail',
    );
    expect(mockProcessorService.processRun).toHaveBeenNthCalledWith(
      2,
      'run-ok',
    );
  });

  describe('onApplicationShutdown', () => {
    it('should abort all active sessions on shutdown', () => {
      service.onApplicationShutdown();

      expect(mockSessionTracker.abortAll).toHaveBeenCalled();
    });
  });
});
