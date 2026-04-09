/* eslint-disable sonarjs/publicly-writable-directories */
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FlowsService } from './flows.service.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowResolverLoaderService } from './flow-resolver-loader.service.js';
import { FlowRunRepository, type FlowRun } from './flow-run.repository.js';
import { FlowRunnerService } from './flow-runner.service.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';

describe('FlowsService', () => {
  let service: FlowsService;
  let flowConfigService: jest.Mocked<FlowConfigService>;
  let flowResolverLoader: jest.Mocked<FlowResolverLoaderService>;
  let flowRunRepository: jest.Mocked<FlowRunRepository>;
  let flowRunner: jest.Mocked<FlowRunnerService>;
  let flowAbortTracker: jest.Mocked<FlowAbortTrackerService>;

  const fakeConfig = {
    resolver: './resolve.ts',
    agents: [{ name: 'dev', cwd: '/tmp/my-repo', prompt: 'do {{task}}' }],
  };

  const fakeResolver = jest.fn();

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        FlowsService,
        {
          provide: FlowConfigService,
          useValue: {
            listFlows: jest.fn(),
            loadFlow: jest.fn().mockReturnValue(fakeConfig),
            getFlowDir: jest.fn().mockReturnValue('/fake/flows/factory'),
          },
        },
        {
          provide: FlowResolverLoaderService,
          useValue: { load: jest.fn().mockResolvedValue(fakeResolver) },
        },
        {
          provide: FlowRunRepository,
          useValue: {
            create: jest.fn(),
            findById: jest.fn(),
            findByFlowName: jest.fn(),
          },
        },
        {
          provide: FlowRunnerService,
          useValue: { run: jest.fn() },
        },
        {
          provide: FlowAbortTrackerService,
          useValue: { track: jest.fn(), abort: jest.fn(), untrack: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(FlowsService);
    flowConfigService = module.get(FlowConfigService);
    flowResolverLoader = module.get(FlowResolverLoaderService);
    flowRunRepository = module.get(FlowRunRepository);
    flowRunner = module.get(FlowRunnerService);
    flowAbortTracker = module.get(FlowAbortTrackerService);
  });

  // ── listFlows ──────────────────────────────────────────────────────

  describe('listFlows', () => {
    it('should delegate to FlowConfigService.listFlows', () => {
      const flows = [
        { name: 'factory', configPath: '/fake/factory/config.yaml' },
        { name: 'bugfix', configPath: '/fake/bugfix/config.yaml' },
      ];
      flowConfigService.listFlows.mockReturnValue(flows);

      expect(service.listFlows()).toEqual(flows);
      expect(flowConfigService.listFlows).toHaveBeenCalled();
    });
  });

  // ── listFlowRuns ───────────────────────────────────────────────────

  describe('listFlowRuns', () => {
    it('should return runs for the given flow name', async () => {
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
      flowRunRepository.findByFlowName.mockResolvedValue(runs);

      const result = await service.listFlowRuns('factory');

      expect(flowRunRepository.findByFlowName).toHaveBeenCalledWith('factory');
      expect(result).toEqual(runs);
    });
  });

  // ── getFlowRun ─────────────────────────────────────────────────────

  describe('getFlowRun', () => {
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
      flowRunRepository.findById.mockResolvedValue(run);

      const result = await service.getFlowRun('run-1');

      expect(flowRunRepository.findById).toHaveBeenCalledWith('run-1');
      expect(result).toEqual(run);
    });

    it('should throw NotFoundException when the run does not exist', async () => {
      flowRunRepository.findById.mockResolvedValue(null);

      await expect(service.getFlowRun('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── abortFlowRun ───────────────────────────────────────────────────

  describe('abortFlowRun', () => {
    it('should return aborted=true when the tracker successfully aborts', () => {
      flowAbortTracker.abort.mockReturnValue(true);

      expect(service.abortFlowRun('run-1')).toEqual({ aborted: true });
      expect(flowAbortTracker.abort).toHaveBeenCalledWith('run-1');
    });

    it('should return aborted=false when the tracker has no controller', () => {
      flowAbortTracker.abort.mockReturnValue(false);

      expect(service.abortFlowRun('unknown')).toEqual({ aborted: false });
    });
  });

  // ── startFlow ──────────────────────────────────────────────────────

  describe('startFlow', () => {
    const createdRun: FlowRun = {
      flowRunId: 'run-1',
      flowName: 'factory',
      status: 'running',
      vars: {},
      steps: [],
      startedAt: new Date(),
    };

    beforeEach(() => {
      flowRunRepository.create.mockResolvedValue(createdRun);
    });

    it('should load config + resolver, create the row, track abort, and dispatch to runner', async () => {
      const result = await service.startFlow({
        flowName: 'factory',
        vars: { task: 'feat-1' },
      });

      expect(flowConfigService.loadFlow).toHaveBeenCalledWith('factory');
      expect(flowConfigService.getFlowDir).toHaveBeenCalledWith('factory');
      expect(flowResolverLoader.load).toHaveBeenCalledWith(
        expect.stringContaining('resolve.ts'),
      );
      expect(flowRunRepository.create).toHaveBeenCalledWith('factory', {
        task: 'feat-1',
      });
      expect(flowAbortTracker.track).toHaveBeenCalledWith(
        'run-1',
        expect.any(AbortController),
      );
      expect(flowRunner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          run: createdRun,
          flowDir: '/fake/flows/factory',
          config: fakeConfig,
          resolve: fakeResolver,
          abortSignal: expect.any(AbortSignal),
        }),
      );
      expect(result).toEqual({ flowRunId: 'run-1' });
    });

    it('should propagate NotFoundException from FlowConfigService.loadFlow', async () => {
      flowConfigService.loadFlow.mockImplementation(() => {
        throw new NotFoundException('Flow "nonexistent" not found');
      });

      await expect(
        service.startFlow({ flowName: 'nonexistent', vars: {} }),
      ).rejects.toThrow(NotFoundException);

      expect(flowRunRepository.create).not.toHaveBeenCalled();
      expect(flowRunner.run).not.toHaveBeenCalled();
    });

    it('should propagate BadRequestException from FlowResolverLoaderService', async () => {
      flowResolverLoader.load.mockRejectedValueOnce(
        new BadRequestException('resolver missing'),
      );

      await expect(
        service.startFlow({ flowName: 'factory', vars: {} }),
      ).rejects.toThrow(BadRequestException);

      expect(flowRunRepository.create).not.toHaveBeenCalled();
      expect(flowRunner.run).not.toHaveBeenCalled();
    });
  });
});
