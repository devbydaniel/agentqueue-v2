import { Test } from '@nestjs/testing';
import { ListFlowRunsUseCase } from './list-flow-runs.use-case.js';
import {
  FlowRunRepository,
  type FlowRun,
} from '../infrastructure/flow-run.repository.js';
import { UnexpectedFlowError } from './flows.errors.js';

describe('ListFlowRunsUseCase', () => {
  let useCase: ListFlowRunsUseCase;
  let flowRunRepository: FlowRunRepository;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ListFlowRunsUseCase,
        {
          provide: FlowRunRepository,
          useValue: { findByFlowName: jest.fn() },
        },
      ],
    }).compile();

    useCase = module.get(ListFlowRunsUseCase);
    flowRunRepository = module.get(FlowRunRepository);
  });

  it('should return runs from the repository for the given flow', async () => {
    const runs: FlowRun[] = [
      {
        flowRunId: 'run-1',
        flowName: 'factory',
        status: 'done',
        vars: {},
        steps: [],
        startedAt: new Date(),
      },
    ];
    (flowRunRepository.findByFlowName as jest.Mock).mockResolvedValue(runs);

    const result = await useCase.execute({ flowName: 'factory' });

    expect(flowRunRepository.findByFlowName).toHaveBeenCalledWith('factory');
    expect(result).toEqual(runs);
  });

  it('should wrap unexpected errors in UnexpectedFlowError', async () => {
    (flowRunRepository.findByFlowName as jest.Mock).mockRejectedValueOnce(
      new Error('db crashed'),
    );

    await expect(useCase.execute({ flowName: 'factory' })).rejects.toThrow(
      UnexpectedFlowError,
    );
  });
});
