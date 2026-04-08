import { Test } from '@nestjs/testing';
import { FlowRunStartupRecoveryService } from './flow-run-startup-recovery.service.js';
import { FlowRunRepository } from './flow-run.repository.js';

describe('FlowRunStartupRecoveryService', () => {
  let service: FlowRunStartupRecoveryService;
  let mockFlowRunRepository: { markRunningAsInterrupted: jest.Mock };

  beforeEach(async () => {
    mockFlowRunRepository = {
      markRunningAsInterrupted: jest.fn().mockResolvedValue([]),
    };

    const module = await Test.createTestingModule({
      providers: [
        FlowRunStartupRecoveryService,
        { provide: FlowRunRepository, useValue: mockFlowRunRepository },
      ],
    }).compile();

    service = module.get(FlowRunStartupRecoveryService);
  });

  it('should call markRunningAsInterrupted on flow run repository', async () => {
    mockFlowRunRepository.markRunningAsInterrupted.mockResolvedValueOnce([
      { flowRunId: 'flow-1' },
    ]);

    await service.onModuleInit();

    expect(mockFlowRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
  });

  it('should do nothing when no abandoned flow runs exist', async () => {
    await service.onModuleInit();

    expect(mockFlowRunRepository.markRunningAsInterrupted).toHaveBeenCalled();
  });

  it('should catch flow recovery errors without throwing', async () => {
    mockFlowRunRepository.markRunningAsInterrupted.mockRejectedValueOnce(
      new Error('DB unreachable'),
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });
});
