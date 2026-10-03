import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RunsService } from './runs.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunRepository } from './run.repository.js';
import { RunEventRepository } from './run-event.repository.js';
import { BOSS } from '../queue/queue.tokens.js';
import type { Run } from '../database/runs.schema.js';

describe('RunsService', () => {
  let service: RunsService;
  let runProcessorService: RunProcessorService;
  let runRepository: RunRepository;
  let runEventRepository: RunEventRepository;
  let mockBoss: { send: jest.Mock; cancel: jest.Mock };
  let tmpDir: string;

  function makeRun(overrides: Partial<Run> = {}): Run {
    return {
      id: 'run-abc',
      source: 'manual',
      triggerName: null,
      agentName: null,
      parentRunId: null,
      cwd: tmpDir,
      prompt: 'do something',
      promptPreview: 'do something',
      status: 'waiting',
      attemptsMade: 0,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      externalSessionId: null,
      appendSystemPrompt: null,
      timeoutMs: null,
      queueJobId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-service-test-'));

    mockBoss = {
      send: jest.fn().mockResolvedValue('job-123'),
      cancel: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        RunsService,
        {
          provide: RunProcessorService,
          useValue: {
            runSession: jest.fn().mockResolvedValue({ success: true }),
            abortSession: jest.fn().mockReturnValue(true),
            abortByRunId: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: RunRepository,
          useValue: {
            create: jest.fn().mockResolvedValue(makeRun()),
            findById: jest.fn().mockResolvedValue(makeRun()),
            findMany: jest.fn().mockResolvedValue([]),
            markWaitingQueueJob: jest.fn().mockResolvedValue(undefined),
            save: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RunEventRepository,
          useValue: {
            findByRunId: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: BOSS,
          useValue: mockBoss,
        },
      ],
    }).compile();

    service = module.get(RunsService);
    runProcessorService = module.get(RunProcessorService);
    runRepository = module.get(RunRepository);
    runEventRepository = module.get(RunEventRepository);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('abortSession', () => {
    it('should delegate abort to the processor', () => {
      const result = service.abortSession('linear-session-1');

      expect(runProcessorService.abortSession).toHaveBeenCalledWith(
        'linear-session-1',
      );
      expect(result).toBe(true);
    });
  });

  describe('enqueue', () => {
    it('should create a run row, enqueue a job, and return runId + status', async () => {
      const result = await service.enqueue({
        source: 'manual',
        cwd: tmpDir,
        prompt: 'do something',
      });

      expect(runRepository.create).toHaveBeenCalledWith({
        source: 'manual',
        triggerName: undefined,
        parentRunId: undefined,
        cwd: tmpDir,
        prompt: 'do something',
        externalSessionId: undefined,
        appendSystemPrompt: undefined,
      });

      expect(mockBoss.send).toHaveBeenCalledWith(
        'runs',
        { runId: 'run-abc' },
        {},
      );

      expect(runRepository.markWaitingQueueJob).toHaveBeenCalledWith(
        'run-abc',
        'job-123',
      );

      expect(result).toEqual({ runId: 'run-abc', status: 'waiting' });
    });

    it('should forward all optional fields to create', async () => {
      await service.enqueue({
        source: 'linear',
        triggerName: 'my-agent',
        cwd: tmpDir,
        prompt: 'fix bug',
        externalSessionId: 'session-key-1',
        appendSystemPrompt: 'append',
      });

      expect(runRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'linear',
          triggerName: 'my-agent',
          externalSessionId: 'session-key-1',
          appendSystemPrompt: 'append',
        }),
      );
    });

    it('should group jobs by external session so a session runs serially', async () => {
      await service.enqueue({
        source: 'telegram',
        cwd: tmpDir,
        prompt: 'follow-up',
        externalSessionId: 'telegram:daniel:42:main',
      });

      expect(mockBoss.send).toHaveBeenCalledWith(
        'runs',
        { runId: 'run-abc' },
        { group: { id: 'telegram:daniel:42:main' } },
      );
    });

    it('should not call markWaitingQueueJob when boss.send returns null', async () => {
      mockBoss.send.mockResolvedValueOnce(null);

      await service.enqueue({
        source: 'manual',
        cwd: tmpDir,
        prompt: 'hello',
      });

      expect(runRepository.markWaitingQueueJob).not.toHaveBeenCalled();
    });

    it('should mark run as errored and re-throw when boss.send fails', async () => {
      const createdRun = makeRun();
      (runRepository.create as jest.Mock).mockResolvedValueOnce(createdRun);
      mockBoss.send.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(
        service.enqueue({
          source: 'manual',
          cwd: tmpDir,
          prompt: 'do something',
        }),
      ).rejects.toThrow('queue unavailable');

      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'run-abc',
          status: 'errored',
          errorMessage: 'queue unavailable',
        }),
      );
      expect(createdRun.completedAt).toBeInstanceOf(Date);
    });

    it('should propagate DB errors from create', async () => {
      (runRepository.create as jest.Mock).mockRejectedValueOnce(
        new Error('DB connection failed'),
      );

      await expect(
        service.enqueue({
          source: 'manual',
          cwd: tmpDir,
          prompt: 'hello',
        }),
      ).rejects.toThrow('DB connection failed');
    });
  });

  describe('getRun', () => {
    it('should return the run when found', async () => {
      const run = makeRun({ id: 'run-xyz' });
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);

      const result = await service.getRun('run-xyz');

      expect(result).toBe(run);
      expect(runRepository.findById).toHaveBeenCalledWith('run-xyz');
    });

    it('should throw NotFoundException when run does not exist', async () => {
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.getRun('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('listRuns', () => {
    it('should delegate to runRepository.findMany', async () => {
      const runs = [makeRun({ id: 'run-1' }), makeRun({ id: 'run-2' })];
      (runRepository.findMany as jest.Mock).mockResolvedValueOnce(runs);

      const result = await service.listRuns({ status: 'running', limit: 10 });

      expect(result).toBe(runs);
      expect(runRepository.findMany).toHaveBeenCalledWith({
        status: 'running',
        limit: 10,
      });
    });

    it('should return empty array when no runs match', async () => {
      (runRepository.findMany as jest.Mock).mockResolvedValueOnce([]);

      const result = await service.listRuns({});

      expect(result).toEqual([]);
    });
  });

  describe('listRunEvents', () => {
    it('should return events for an existing run', async () => {
      const run = makeRun({ id: 'run-abc' });
      const events = [
        { id: 'e1', runId: 'run-abc', type: 'agent_start', payload: {} },
      ];
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);
      (runEventRepository.findByRunId as jest.Mock).mockResolvedValueOnce(
        events,
      );

      const result = await service.listRunEvents('run-abc', { limit: 50 });

      expect(result).toBe(events);
      expect(runEventRepository.findByRunId).toHaveBeenCalledWith('run-abc', {
        limit: 50,
      });
    });

    it('should throw NotFoundException when run does not exist', async () => {
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.listRunEvents('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('abortRun', () => {
    it('should abort a running run via processor', async () => {
      const run = makeRun({ status: 'running' });
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);

      const result = await service.abortRun('run-abc');

      expect(result).toEqual({ aborted: true });
      expect(runProcessorService.abortByRunId).toHaveBeenCalledWith('run-abc');
      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'aborted',
          completedAt: expect.any(Date),
        }),
      );
    });

    it('should return aborted false when processor cannot find running session', async () => {
      const run = makeRun({ status: 'running' });
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);
      (runProcessorService.abortByRunId as jest.Mock).mockReturnValueOnce(
        false,
      );

      const result = await service.abortRun('run-abc');

      expect(result).toEqual({ aborted: false });
      expect(runRepository.save).not.toHaveBeenCalled();
    });

    it('should cancel queue job for a waiting run', async () => {
      const run = makeRun({
        status: 'waiting',
        queueJobId: 'job-xyz',
      });
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);

      const result = await service.abortRun('run-abc');

      expect(result).toEqual({ aborted: true });
      expect(mockBoss.cancel).toHaveBeenCalledWith('runs', 'job-xyz');
      expect(runRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'aborted',
          completedAt: expect.any(Date),
        }),
      );
    });

    it('should throw NotFoundException when run does not exist', async () => {
      (runRepository.findById as jest.Mock).mockResolvedValueOnce(null);

      await expect(service.abortRun('nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ConflictException for terminal runs', async () => {
      for (const status of [
        'succeeded',
        'errored',
        'aborted',
        'timed_out',
        'interrupted',
      ] as const) {
        const run = makeRun({ status });
        (runRepository.findById as jest.Mock).mockResolvedValueOnce(run);

        await expect(service.abortRun('run-abc')).rejects.toThrow(
          ConflictException,
        );
      }
    });
  });
});
