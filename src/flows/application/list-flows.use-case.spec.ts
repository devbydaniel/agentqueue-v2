import { Test } from '@nestjs/testing';
import { ListFlowsUseCase } from './list-flows.use-case.js';
import { FlowConfigService } from '../flow-config.service.js';
import { UnexpectedFlowError } from './flows.errors.js';

describe('ListFlowsUseCase', () => {
  let useCase: ListFlowsUseCase;
  let flowConfigService: FlowConfigService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        ListFlowsUseCase,
        {
          provide: FlowConfigService,
          useValue: { listFlows: jest.fn() },
        },
      ],
    }).compile();

    useCase = module.get(ListFlowsUseCase);
    flowConfigService = module.get(FlowConfigService);
  });

  it('should return the list of flows from the config service', async () => {
    const flows = [
      {
        name: 'factory',
        configPath: '/home/.agentqueue/flows/factory/config.yaml',
      },
      {
        name: 'bugfix',
        configPath: '/home/.agentqueue/flows/bugfix/config.yaml',
      },
    ];
    (flowConfigService.listFlows as jest.Mock).mockReturnValue(flows);

    const result = await useCase.execute();

    expect(result).toEqual(flows);
    expect(flowConfigService.listFlows).toHaveBeenCalled();
  });

  it('should wrap unexpected errors in UnexpectedFlowError', async () => {
    (flowConfigService.listFlows as jest.Mock).mockImplementation(() => {
      throw new Error('fs explosion');
    });

    await expect(useCase.execute()).rejects.toThrow(UnexpectedFlowError);
  });
});
