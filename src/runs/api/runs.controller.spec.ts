import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { RunsController } from './runs.controller.js';
import { ExecuteRunUseCase } from '../application/execute-run.use-case.js';

describe('RunsController', () => {
  let app: INestApplication;
  let executeRunUseCase: ExecuteRunUseCase;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [
        {
          provide: ExecuteRunUseCase,
          useValue: {
            execute: jest.fn().mockResolvedValue({ success: true }),
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

    executeRunUseCase = module.get(ExecuteRunUseCase);
  });

  afterEach(async () => {
    await app.close();
  });

  it('should return success when given valid input', async () => {
    const response = await request(app.getHttpServer())
      .post('/runs')
      .send({ repo: 'core', prompt: 'do something' })
      .expect(201);

    expect(response.body).toEqual({ success: true });
    expect(executeRunUseCase.execute).toHaveBeenCalledWith({
      repo: 'core',
      prompt: 'do something',
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
