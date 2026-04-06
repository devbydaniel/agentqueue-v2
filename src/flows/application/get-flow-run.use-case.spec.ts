import { Test } from '@nestjs/testing';
import { GetFlowRunUseCase } from './get-flow-run.use-case.js';
import {
  FlowRunRepository,
  type FlowRun,
} from '../infrastructure/flow-run.repository.js';
import { FlowRunNotFoundError, UnexpectedFlowError } from './flows.errors.js';

describe('GetFlowRunUseCase', () => {
  let useCase: GetFlowRunUseCase;
  let flowRunRepository: FlowRunRepository;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        GetFlowRunUseCase,
        {
          provide: FlowRunRepository,
          useValue: { findById: jest.fn() },
        },
      ],
    }).compile();

    useCase = module.get(GetFlowRunUseCase);
    flowRunRepository = module.get(FlowRunRepository);
  });

  it('should return the run when found', async () => {
    const run: FlowRun = {
      flowRunId: 'run-1',
      flowName: 'factory',
      status: 'running',
      vars: { task: 'feat-1' },
      currentAgent: 'dev',
      steps: [],
      startedAt: new Date(),
    };
    (flowRunRepository.findById as jest.Mock).mockResolvedValue(run);

    const result = await useCase.execute({ flowRunId: 'run-1' });

    expect(flowRunRepository.findById).toHaveBeenCalledWith('run-1');
    expect(result).toEqual(run);
  });

  it('should throw FlowRunNotFoundError when the run does not exist', async () => {
    (flowRunRepository.findById as jest.Mock).mockResolvedValue(null);

    await expect(useCase.execute({ flowRunId: 'nonexistent' })).rejects.toThrow(
      FlowRunNotFoundError,
    );
  });

  it('should wrap unexpected errors in UnexpectedFlowError', async () => {
    (flowRunRepository.findById as jest.Mock).mockRejectedValueOnce(
      new Error('db crashed'),
    );

    await expect(useCase.execute({ flowRunId: 'run-1' })).rejects.toThrow(
      UnexpectedFlowError,
    );
  });
});
