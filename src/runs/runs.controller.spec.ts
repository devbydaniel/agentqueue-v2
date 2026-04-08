import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  ValidationPipe,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import request from 'supertest';
import { RunsController } from './runs.controller.js';
import { RunsService } from './runs.service.js';

describe('RunsController', () => {
  let app: INestApplication;
  let runsService: RunsService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [
        {
          provide: RunsService,
          useValue: {
            enqueue: jest
              .fn()
              .mockResolvedValue({ runId: 'run-abc', status: 'waiting' }),
            getRun: jest.fn().mockResolvedValue({
              id: 'run-abc',
              source: 'manual',
              status: 'running',
              repo: 'core',
            }),
            listRuns: jest.fn().mockResolvedValue([]),
            listRunEvents: jest.fn().mockResolvedValue([]),
            abortRun: jest.fn().mockResolvedValue({ aborted: true }),
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();

    runsService = module.get(RunsService);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /runs', () => {
    it('should return 202 with runId and status when given valid input', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({ repo: 'core', prompt: 'do something' })
        .expect(202);

      expect(response.body).toEqual({ runId: 'run-abc', status: 'waiting' });
      expect(runsService.enqueue).toHaveBeenCalledWith({
        source: 'manual',
        repo: 'core',
        prompt: 'do something',
      });
    });

    it('should forward optional fields to enqueue', async () => {
      await request(app.getHttpServer())
        .post('/runs')
        .send({
          repo: 'core',
          prompt: 'do something',
          sessionKey: 'sk-1',
          prependSystemPrompt: 'prepend',
          appendSystemPrompt: 'append',
        })
        .expect(202);

      expect(runsService.enqueue).toHaveBeenCalledWith({
        source: 'manual',
        repo: 'core',
        prompt: 'do something',
        sessionKey: 'sk-1',
        prependSystemPrompt: 'prepend',
        appendSystemPrompt: 'append',
      });
    });

    it('should return 400 when repo is missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({ prompt: 'do something' });
      expect(response.status).toBe(400);
    });

    it('should return 400 when prompt is missing', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({ repo: 'core' });
      expect(response.status).toBe(400);
    });

    it('should return 400 when repo is empty string', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({ repo: '', prompt: 'do something' });
      expect(response.status).toBe(400);
    });

    it('should return 400 when prompt is empty string', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({ repo: 'core', prompt: '' });
      expect(response.status).toBe(400);
    });

    it('should return 400 when body is empty', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs')
        .send({});
      expect(response.status).toBe(400);
    });
  });

  describe('GET /runs', () => {
    it('should return 200 with a list of runs', async () => {
      const response = await request(app.getHttpServer())
        .get('/runs')
        .expect(200);

      expect(response.body).toEqual([]);
      expect(runsService.listRuns).toHaveBeenCalled();
    });

    it('should forward query params as filters', async () => {
      await request(app.getHttpServer())
        .get('/runs?status=running&source=cron&repo=core&limit=10&offset=5')
        .expect(200);

      expect(runsService.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'running',
          source: 'cron',
          repo: 'core',
          limit: 10,
          offset: 5,
        }),
      );
    });

    it('should return 400 for invalid status value', async () => {
      await request(app.getHttpServer())
        .get('/runs?status=invalid')
        .expect(400);
    });

    it('should return 400 for invalid source value', async () => {
      await request(app.getHttpServer())
        .get('/runs?source=invalid')
        .expect(400);
    });

    it('should return 400 for invalid since date', async () => {
      await request(app.getHttpServer())
        .get('/runs?since=not-a-date')
        .expect(400);
    });

    it('should accept valid ISO 8601 since date', async () => {
      await request(app.getHttpServer())
        .get('/runs?since=2024-01-01T00:00:00Z')
        .expect(200);
    });
  });

  describe('GET /runs/:id', () => {
    it('should return 200 with run details', async () => {
      const response = await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000')
        .expect(200);

      expect(response.body).toEqual(expect.objectContaining({ id: 'run-abc' }));
      expect(runsService.getRun).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('should return 404 when run does not exist', async () => {
      (runsService.getRun as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Run not found'),
      );

      await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000')
        .expect(404);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app.getHttpServer()).get(
        '/runs/not-a-uuid',
      );
      expect(response.status).toBe(400);
    });
  });

  describe('GET /runs/:id/events', () => {
    it('should return 200 with events', async () => {
      const response = await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000/events')
        .expect(200);

      expect(response.body).toEqual([]);
      expect(runsService.listRunEvents).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
        { limit: undefined, offset: undefined },
      );
    });

    it('should forward pagination params', async () => {
      await request(app.getHttpServer())
        .get(
          '/runs/550e8400-e29b-41d4-a716-446655440000/events?limit=20&offset=10',
        )
        .expect(200);

      expect(runsService.listRunEvents).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
        { limit: 20, offset: 10 },
      );
    });

    it('should return 404 when run does not exist', async () => {
      (runsService.listRunEvents as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Run not found'),
      );

      await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000/events')
        .expect(404);
    });

    it('should return 400 for non-numeric limit', async () => {
      await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000/events?limit=abc')
        .expect(400);
    });

    it('should return 400 for negative offset', async () => {
      await request(app.getHttpServer())
        .get('/runs/550e8400-e29b-41d4-a716-446655440000/events?offset=-1')
        .expect(400);
    });
  });

  describe('POST /runs/:id/abort', () => {
    it('should return 200 with abort result', async () => {
      const response = await request(app.getHttpServer())
        .post('/runs/550e8400-e29b-41d4-a716-446655440000/abort')
        .expect(200);

      expect(response.body).toEqual({ aborted: true });
      expect(runsService.abortRun).toHaveBeenCalledWith(
        '550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('should return 404 when run does not exist', async () => {
      (runsService.abortRun as jest.Mock).mockRejectedValueOnce(
        new NotFoundException('Run not found'),
      );

      await request(app.getHttpServer())
        .post('/runs/550e8400-e29b-41d4-a716-446655440000/abort')
        .expect(404);
    });

    it('should return 409 when run is in terminal state', async () => {
      (runsService.abortRun as jest.Mock).mockRejectedValueOnce(
        new ConflictException('Already terminal'),
      );

      await request(app.getHttpServer())
        .post('/runs/550e8400-e29b-41d4-a716-446655440000/abort')
        .expect(409);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app.getHttpServer()).post(
        '/runs/not-a-uuid/abort',
      );
      expect(response.status).toBe(400);
    });
  });
});
