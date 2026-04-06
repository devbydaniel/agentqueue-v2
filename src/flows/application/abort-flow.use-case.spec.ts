import { Test } from '@nestjs/testing';
import { AbortFlowUseCase } from './abort-flow.use-case.js';
import { FlowAbortTrackerService } from '../flow-abort-tracker.service.js';

describe('AbortFlowUseCase', () => {
  let useCase: AbortFlowUseCase;
  let flowAbortTracker: FlowAbortTrackerService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AbortFlowUseCase,
        {
          provide: FlowAbortTrackerService,
          useValue: { abort: jest.fn() },
        },
      ],
    }).compile();

    useCase = module.get(AbortFlowUseCase);
    flowAbortTracker = module.get(FlowAbortTrackerService);
  });

  it('should return aborted=true when the tracker successfully aborts', async () => {
    (flowAbortTracker.abort as jest.Mock).mockReturnValue(true);

    const result = await useCase.execute({ flowRunId: 'run-1' });

    expect(flowAbortTracker.abort).toHaveBeenCalledWith('run-1');
    expect(result).toEqual({ aborted: true });
  });

  it('should return aborted=false when the tracker has no controller', async () => {
    (flowAbortTracker.abort as jest.Mock).mockReturnValue(false);

    const result = await useCase.execute({ flowRunId: 'unknown' });

    expect(result).toEqual({ aborted: false });
  });
});
