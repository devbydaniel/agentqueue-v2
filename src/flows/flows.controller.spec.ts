import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import request from 'supertest';
import { FlowsController } from './flows.controller.js';
import { FlowsService } from './flows.service.js';
import type { FlowRun } from './flow-run.repository.js';

describe('FlowsController', () => {
  let app: INestApplication;

  const mockFlowsService = {
    listFlows: jest.fn(),
    listFlowRuns: jest.fn(),
    getFlowRun: jest.fn(),
    abortFlowRun: jest.fn(),
    startFlow: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module = await Test.createTestingModule({
      controllers: [FlowsController],
      providers: [{ provide: FlowsService, useValue: mockFlowsService }],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /flows', () => {
    it('should return flow list', async () => {
      mockFlowsService.listFlows.mockReturnValue([
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
      mockFlowsService.startFlow.mockResolvedValue({ flowRunId: 'run-123' });

      const res = await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({ vars: { task: 'feat-1' } })
        .expect(200);

      expect(res.body).toEqual({ flowRunId: 'run-123' });
      expect(mockFlowsService.startFlow).toHaveBeenCalledWith({
        flowName: 'factory',
        vars: { task: 'feat-1' },
      });
    });

    it('should default vars to empty object', async () => {
      mockFlowsService.startFlow.mockResolvedValue({ flowRunId: 'run-456' });

      await request(app.getHttpServer())
        .post('/flows/factory/start')
        .send({})
        .expect(200);

      expect(mockFlowsService.startFlow).toHaveBeenCalledWith({
        flowName: 'factory',
        vars: {},
      });
    });

    it('should return 404 when service throws NotFoundException', async () => {
      mockFlowsService.startFlow.mockRejectedValueOnce(
        new NotFoundException('Flow "nonexistent" not found'),
      );

      const res = await request(app.getHttpServer())
        .post('/flows/nonexistent/start')
        .send({});

      expect(res.status).toBe(404);
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
      mockFlowsService.listFlowRuns.mockResolvedValue(runs);

      const res = await request(app.getHttpServer())
        .get('/flows/factory/runs')
        .expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].flowRunId).toBe('run-1');
      expect(mockFlowsService.listFlowRuns).toHaveBeenCalledWith('factory');
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
      mockFlowsService.getFlowRun.mockResolvedValue(run);

      const res = await request(app.getHttpServer())
        .get('/flows/runs/run-1')
        .expect(200);

      expect(res.body.flowRunId).toBe('run-1');
      expect(res.body.status).toBe('running');
      expect(mockFlowsService.getFlowRun).toHaveBeenCalledWith('run-1');
    });

    it('should return 404 for unknown run ID', async () => {
      mockFlowsService.getFlowRun.mockRejectedValueOnce(
        new NotFoundException('Flow run "nonexistent" not found'),
      );

      const res = await request(app.getHttpServer()).get(
        '/flows/runs/nonexistent',
      );

      expect(res.status).toBe(404);
    });
  });

  describe('POST /flows/runs/:runId/abort', () => {
    it('should return aborted=true when service reports success', async () => {
      mockFlowsService.abortFlowRun.mockReturnValue({ aborted: true });

      const res = await request(app.getHttpServer())
        .post('/flows/runs/run-1/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: true });
      expect(mockFlowsService.abortFlowRun).toHaveBeenCalledWith('run-1');
    });

    it('should return aborted=false when no active run', async () => {
      mockFlowsService.abortFlowRun.mockReturnValue({ aborted: false });

      const res = await request(app.getHttpServer())
        .post('/flows/runs/nonexistent/abort')
        .expect(200);

      expect(res.body).toEqual({ aborted: false });
    });
  });
});
