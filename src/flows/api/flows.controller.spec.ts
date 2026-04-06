import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { FlowsController } from './flows.controller.js';
import { StartFlowUseCase } from '../application/start-flow.use-case.js';
import { AbortFlowUseCase } from '../application/abort-flow.use-case.js';
import { ListFlowsUseCase } from '../application/list-flows.use-case.js';
import { ListFlowRunsUseCase } from '../application/list-flow-runs.use-case.js';
import { GetFlowRunUseCase } from '../application/get-flow-run.use-case.js';
import { ApplicationErrorFilter } from '../../common/filters/application-error.filter.js';
import {
  FlowNotFoundError,
  FlowRunNotFoundError,
} from '../application/flows.errors.js';
import type { FlowRun } from '../infrastructure/flow-run.repository.js';

describe('FlowsController', () => {
  let app: INestApplication;

  const mockStartFlow = { execute: jest.fn() };
  const mockAbortFlow = { execute: jest.fn() };
  const mockListFlows = { execute: jest.fn() };
  const mockListFlowRuns = { execute: jest.fn() };
  const mockGetFlowRun = { execute: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [FlowsController],
      providers: [
        { provide: StartFlowUseCase, useValue: mockStartFlow },
        { provide: AbortFlowUseCase, useValue: mockAbortFlow },
        { provide: ListFlowsUseCase, useValue: mockListFlows },
        { provide: ListFlowRunsUseCase, useValue: mockListFlowRuns },
        { provide: GetFlowRunUseCase, useValue: mockGetFlowRun },
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
      mockListFlows.execute.mockResolvedValue([
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
      mockStartFlow.execute.mockResolvedValue({ flowRunId: 'run-123' });

      const res = await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({ vars: { task: 'feat-1' } })
        .expect(200);

      expect(res.body).toEqual({ flowRunId: 'run-123' });
      expect(mockStartFlow.execute).toHaveBeenCalledWith({
        flowName: 'factory',
        vars: { task: 'feat-1' },
      });
    });

    it('should default vars to empty object', async () => {
      mockStartFlow.execute.mockResolvedValue({ flowRunId: 'run-456' });

      await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({})
        .expect(200);

      expect(mockStartFlow.execute).toHaveBeenCalledWith({
        flowName: 'factory',
        vars: {},
      });
    });

    it('should return 404 for non-existent flow', async () => {
      mockStartFlow.execute.mockRejectedValueOnce(
        new FlowNotFoundError('nonexistent'),
      );

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
      mockListFlowRuns.execute.mockResolvedValue(runs);

      const res = await request(app.getHttpServer())
        .get('/flows/factory/runs')
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].flowRunId).toBe('run-1');
      expect(mockListFlowRuns.execute).toHaveBeenCalledWith({
        flowName: 'factory',
      });
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
      mockGetFlowRun.execute.mockResolvedValue(run);

      const res = await request(app.getHttpServer())
        .get('/flows/runs/run-1')
        .expect(200);

      expect(res.body.flowRunId).toBe('run-1');
      expect(res.body.status).toBe('running');
      expect(mockGetFlowRun.execute).toHaveBeenCalledWith({
        flowRunId: 'run-1',
      });
    });

    it('should return 404 for unknown run ID', async () => {
      mockGetFlowRun.execute.mockRejectedValueOnce(
        new FlowRunNotFoundError('nonexistent'),
      );

      const res = await request(app.getHttpServer())
        .get('/flows/runs/nonexistent')
        .expect(404);

      expect(res.body.code).toBe('FLOW_RUN_NOT_FOUND');
    });
  });

  describe('POST /flows/runs/:runId/abort', () => {
    it('should return aborted status', async () => {
      mockAbortFlow.execute.mockResolvedValue({ aborted: true });

      const res = await request(app.getHttpServer())
        .post('/flows/runs/run-1/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: true });
      expect(mockAbortFlow.execute).toHaveBeenCalledWith({
        flowRunId: 'run-1',
      });
    });

    it('should return false when no active run', async () => {
      mockAbortFlow.execute.mockResolvedValue({ aborted: false });

      const res = await request(app.getHttpServer())
        .post('/flows/runs/nonexistent/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: false });
    });
  });
});
