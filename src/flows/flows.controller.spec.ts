import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { FlowsController } from './flows.controller.js';
import { FlowConfigService } from './flow-config.service.js';
import { FlowRunRepository } from './infrastructure/flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import { FlowExecutorService } from './application/flow-executor.service.js';
import { ApplicationErrorFilter } from '../common/filters/application-error.filter.js';
import type { FlowRun } from './infrastructure/flow-run.repository.js';

describe('FlowsController', () => {
  let app: INestApplication;

  const mockFlowConfigService = {
    listFlows: jest.fn(),
    loadFlow: jest.fn(),
  };

  const mockFlowRunRepository = {
    findByFlowName: jest.fn(),
    findById: jest.fn(),
  };

  const mockFlowAbortTracker = {
    abort: jest.fn(),
  };

  const mockFlowExecutor = {
    start: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [FlowsController],
      providers: [
        { provide: FlowConfigService, useValue: mockFlowConfigService },
        { provide: FlowRunRepository, useValue: mockFlowRunRepository },
        {
          provide: FlowAbortTrackerService,
          useValue: mockFlowAbortTracker,
        },
        { provide: FlowExecutorService, useValue: mockFlowExecutor },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new ApplicationErrorFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /flows', () => {
    it('should return flow list', async () => {
      mockFlowConfigService.listFlows.mockReturnValue([
        {
          name: 'factory',
          configPath: '/home/.agentqueue/flows/factory/config.yaml',
        },
        {
          name: 'bugfix',
          configPath: '/home/.agentqueue/flows/bugfix/config.yaml',
        },
      ]);

      const res = await request(app.getHttpServer()).get('/flows').expect(200);

      expect(res.body).toHaveLength(2);
      expect(res.body[0].name).toBe('factory');
      expect(res.body[1].name).toBe('bugfix');
    });
  });

  describe('POST /flows/:name/start', () => {
    it('should return flowRunId', async () => {
      mockFlowConfigService.loadFlow.mockReturnValue({
        resolver: './resolve.ts',
        agents: [],
      });
      mockFlowExecutor.start.mockResolvedValue('run-123');

      const res = await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({ vars: { task: 'feat-1' } })
        .expect(200);

      expect(res.body).toEqual({ flowRunId: 'run-123' });
      expect(mockFlowExecutor.start).toHaveBeenCalledWith('factory', {
        task: 'feat-1',
      });
    });

    it('should default vars to empty object', async () => {
      mockFlowConfigService.loadFlow.mockReturnValue({
        resolver: './resolve.ts',
        agents: [],
      });
      mockFlowExecutor.start.mockResolvedValue('run-456');

      await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({})
        .expect(200);

      expect(mockFlowExecutor.start).toHaveBeenCalledWith('factory', {});
    });

    it('should return 404 for non-existent flow', async () => {
      mockFlowConfigService.loadFlow.mockImplementation(() => {
        throw new Error('not found');
      });

      const res = await request(app.getHttpServer())
        .post('/flows/nonexistent/start')
        .send({})
        .expect(404);

      expect(res.body.code).toBe('FLOW_NOT_FOUND');
    });
  });

  describe('GET /flows/:name/runs', () => {
    it('should return runs for flow', async () => {
      const runs: FlowRun[] = [
        {
          flowRunId: 'run-1',
          flowName: 'factory',
          status: 'done',
          vars: {},
          steps: [],
          startedAt: new Date(),
          completedAt: new Date(),
        },
      ];
      mockFlowRunRepository.findByFlowName.mockResolvedValue(runs);

      const res = await request(app.getHttpServer())
        .get('/flows/factory/runs')
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].flowRunId).toBe('run-1');
    });
  });

  describe('GET /flows/runs/:runId', () => {
    it('should return run details', async () => {
      const run: FlowRun = {
        flowRunId: 'run-1',
        flowName: 'factory',
        status: 'running',
        vars: { task: 'feat-1' },
        currentAgent: 'dev',
        steps: [],
        startedAt: new Date(),
      };
      mockFlowRunRepository.findById.mockResolvedValue(run);

      const res = await request(app.getHttpServer())
        .get('/flows/runs/run-1')
        .expect(200);

      expect(res.body.flowRunId).toBe('run-1');
      expect(res.body.status).toBe('running');
    });

    it('should return 404 for unknown run ID', async () => {
      mockFlowRunRepository.findById.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .get('/flows/runs/nonexistent')
        .expect(404);

      expect(res.body.code).toBe('FLOW_RUN_NOT_FOUND');
    });
  });

  describe('POST /flows/runs/:runId/abort', () => {
    it('should return aborted status', async () => {
      mockFlowAbortTracker.abort.mockReturnValue(true);

      const res = await request(app.getHttpServer())
        .post('/flows/runs/run-1/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: true });
    });

    it('should return false when no active run', async () => {
      mockFlowAbortTracker.abort.mockReturnValue(false);

      const res = await request(app.getHttpServer())
        .post('/flows/runs/nonexistent/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: false });
    });
  });
});
