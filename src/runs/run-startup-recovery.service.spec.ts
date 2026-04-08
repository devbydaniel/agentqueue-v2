import { Test } from '@nestjs/testing';
import { RunStartupRecoveryService } from './run-startup-recovery.service.js';
import { RunRepository } from './run.repository.js';

describe('RunStartupRecoveryService', () => {
  let service: RunStartupRecoveryService;
  let mockRunRepository: { markRunningAsInterrupted: jest.Mock };

  beforeEach(async () => {
    mockRunRepository = {
      markRunningAsInterrupted: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        RunStartupRecoveryService,
        { provide: RunRepository, useValue: mockRunRepository },
      ],
    }).compile();

    service = module.get(RunStartupRecoveryService);
  });

  it('should call markRunningAsInterrupted on run repository', async () => {
    mockRunRepository.markRunningAsInterrupted.mockResolvedValueOnce([
      { id: 'run-1' },
      { id: 'run-2' },
    ]);

    await service.onModuleInit();

    expect(mockRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
  });

  it('should do nothing when no abandoned runs exist', async () => {
    await service.onModuleInit();

    expect(mockRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
  });

  it('should catch run recovery errors without throwing', async () => {
    mockRunRepository.markRunningAsInterrupted.mockRejectedValueOnce(
      new Error('DB unreachable'),
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
