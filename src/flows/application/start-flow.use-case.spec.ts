import { Test } from '@nestjs/testing';
import { StartFlowUseCase } from './start-flow.use-case.js';
import { FlowConfigService } from '../infrastructure/flow-config.service.js';
import { FlowRunRepository } from '../infrastructure/flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowNotFoundError, UnexpectedFlowError } from './flows.errors.js';

describe('StartFlowUseCase', () => {
  let useCase: StartFlowUseCase;
  let flowConfigService: FlowConfigService;
  let flowRunRepository: FlowRunRepository;
  let flowRunnerService: FlowRunnerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        StartFlowUseCase,
        {
          provide: FlowConfigService,
          useValue: {
            loadFlow: jest.fn().mockReturnValue({
              resolver: './resolve.ts',
              agents: [],
            }),
          },
        },
        {
          provide: FlowRunRepository,
          useValue: {
            create: jest.fn().mockResolvedValue({
              flowRunId: 'run-1',
              flowName: 'factory',
              status: 'running',
              vars: {},
              steps: [],
              startedAt: new Date(),
            }),
          },
        },
        {
          provide: FlowRunnerService,
          useValue: { run: jest.fn() },
        },
      ],
    }).compile();

    useCase = module.get(StartFlowUseCase);
    flowConfigService = module.get(FlowConfigService);
    flowRunRepository = module.get(FlowRunRepository);
    flowRunnerService = module.get(FlowRunnerService);
  });

  it('should validate, create the row, and hand off to the runner', async () => {
    const result = await useCase.execute({
      flowName: 'factory',
      vars: { task: 'feat-1' },
    });

    expect(flowConfigService.loadFlow).toHaveBeenCalledWith('factory');
    expect(flowRunRepository.create).toHaveBeenCalledWith('factory', {
      task: 'feat-1',
    });
    expect(flowRunnerService.run).toHaveBeenCalledWith('run-1', 'factory', {
      task: 'feat-1',
    });
    expect(result).toEqual({ flowRunId: 'run-1' });
  });

  it('should throw FlowNotFoundError when the flow config cannot be loaded', async () => {
    (flowConfigService.loadFlow as jest.Mock).mockImplementation(() => {
      throw new Error('config missing');
    });

    await expect(
      useCase.execute({ flowName: 'nonexistent', vars: {} }),
    ).rejects.toThrow(FlowNotFoundError);

    expect(flowRunRepository.create).not.toHaveBeenCalled();
    expect(flowRunnerService.run).not.toHaveBeenCalled();
  });

  it('should wrap unexpected repository errors in UnexpectedFlowError', async () => {
    (flowRunRepository.create as jest.Mock).mockRejectedValueOnce(
      new Error('db crashed'),
    );

    await expect(
      useCase.execute({ flowName: 'factory', vars: {} }),
    ).rejects.toThrow(UnexpectedFlowError);
  });
});
