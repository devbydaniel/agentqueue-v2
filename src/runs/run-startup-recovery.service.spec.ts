import { Test } from '@nestjs/testing';
import { RunStartupRecoveryService } from './run-startup-recovery.service.js';
import { RunRepository, type InterruptedRun } from './run.repository.js';
import { LinearCallbackHandlerFactory } from '../callbacks/handlers/linear.callback-handler.js';

const interruptedRun = (
  overrides: Partial<InterruptedRun>,
): InterruptedRun => ({
  id: 'run-1',
  source: 'manual',
  triggerName: null,
  externalSessionId: null,
  errorMessage: 'Process restarted while run was in progress',
  ...overrides,
});

describe('RunStartupRecoveryService', () => {
  let service: RunStartupRecoveryService;
  let mockRunRepository: { markRunningAsInterrupted: jest.Mock };
  let linearHandler: { emitError: jest.Mock };
  let linearFactory: { createForRun: jest.Mock };

  beforeEach(async () => {
    mockRunRepository = {
      markRunningAsInterrupted: jest.fn().mockResolvedValue([]),
    };
    linearHandler = { emitError: jest.fn().mockResolvedValue(undefined) };
    linearFactory = { createForRun: jest.fn().mockReturnValue(linearHandler) };

    const module = await Test.createTestingModule({
      providers: [
        RunStartupRecoveryService,
        { provide: RunRepository, useValue: mockRunRepository },
        { provide: LinearCallbackHandlerFactory, useValue: linearFactory },
      ],
    }).compile();

    service = module.get(RunStartupRecoveryService);
  });

  it('should call markRunningAsInterrupted on run repository', async () => {
    mockRunRepository.markRunningAsInterrupted.mockResolvedValueOnce([
      interruptedRun({ id: 'run-1' }),
      interruptedRun({ id: 'run-2' }),
    ]);

    await service.onModuleInit();

    expect(mockRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
  });

  it('should do nothing when no abandoned runs exist', async () => {
    await service.onModuleInit();
    service.onApplicationBootstrap();

    expect(mockRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
    expect(linearFactory.createForRun).not.toHaveBeenCalled();
  });

  it('should catch run recovery errors without throwing', async () => {
    mockRunRepository.markRunningAsInterrupted.mockRejectedValueOnce(
      new Error('DB unreachable'),
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(() => service.onApplicationBootstrap()).not.toThrow();
  });

  it('should report an interrupted Linear run in its agent session', async () => {
    mockRunRepository.markRunningAsInterrupted.mockResolvedValueOnce([
      interruptedRun({
        source: 'linear',
        triggerName: 'ayc-dev:assigned',
        externalSessionId: 'session-1',
      }),
      interruptedRun({ id: 'run-2', source: 'cron', triggerName: 'nightly' }),
    ]);

    await service.onModuleInit();
    service.onApplicationBootstrap();

    expect(linearFactory.createForRun).toHaveBeenCalledTimes(1);
    expect(linearFactory.createForRun).toHaveBeenCalledWith(
      'ayc-dev:assigned',
      'session-1',
    );
    expect(linearHandler.emitError).toHaveBeenCalledWith(
      'Process restarted while run was in progress',
    );
  });
});
