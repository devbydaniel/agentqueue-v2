import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
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
    const response = await request(app.getHttpServer()).post('/runs').send({});

    expect(response.status).toBe(400);
  });
});
