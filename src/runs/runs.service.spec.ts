import { Test } from '@nestjs/testing';
import { RunsService } from './runs.service.js';
import { RunProcessorService } from './run-processor.service.js';
import { RunRepository } from './run.repository.js';
import { BOSS } from '../queue/queue.tokens.js';

describe('RunsService', () => {
  let service: RunsService;
  let runProcessorService: RunProcessorService;
  let runRepository: RunRepository;
  let mockBoss: { send: jest.Mock };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockBoss = {
      send: jest.fn().mockResolvedValue('job-123'),
    };

    const module = await Test.createTestingModule({
      providers: [
        RunsService,
        {
          provide: RunProcessorService,
          useValue: {
            runSession: jest.fn().mockResolvedValue({ success: true }),
            abortSession: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: RunRepository,
          useValue: {
            create: jest.fn().mockResolvedValue({
              id: 'run-abc',
              status: 'waiting',
              source: 'manual',
              repo: 'core',
              prompt: 'do something',
            }),
            markWaitingQueueJob: jest.fn().mockResolvedValue(undefined),
            save: jest.fn().mockResolvedValue(undefined),
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
  });

  describe('execute', () => {
    it('should delegate to runProcessorService.runSession', async () => {
      const command = { repo: 'core', prompt: 'do something' };

      const result = await service.execute(command);

      expect(runProcessorService.runSession).toHaveBeenCalledWith(command);
      expect(result).toEqual({ success: true });
    });

    it('should forward all command fields to runSession', async () => {
      const command = {
        repo: 'core',
        prompt: 'hello',
        sessionKey: 'session-1',
        prependSystemPrompt: 'prepend',
        appendSystemPrompt: 'append',
      };

      await service.execute(command);

      expect(runProcessorService.runSession).toHaveBeenCalledWith(command);
    });
  });

  describe('abortSession', () => {
    it('should delegate abort to the processor', async () => {
      const result = await service.abortSession('linear-session-1');

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
        repo: 'core',
        prompt: 'do something',
      });

      expect(runRepository.create).toHaveBeenCalledWith({
        source: 'manual',
        triggerName: undefined,
        parentFlowRunId: undefined,
        repo: 'core',
        prompt: 'do something',
        sessionKey: undefined,
        prependSystemPrompt: undefined,
        appendSystemPrompt: undefined,
      });

      expect(mockBoss.send).toHaveBeenCalledWith('runs', {
        runId: 'run-abc',
      });

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
        repo: 'core',
        prompt: 'fix bug',
        sessionKey: 'session-key-1',
        prependSystemPrompt: 'prepend',
        appendSystemPrompt: 'append',
      });

      expect(runRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'linear',
          triggerName: 'my-agent',
          sessionKey: 'session-key-1',
          prependSystemPrompt: 'prepend',
          appendSystemPrompt: 'append',
        }),
      );
    });

    it('should not call markWaitingQueueJob when boss.send returns null', async () => {
      mockBoss.send.mockResolvedValueOnce(null);

      await service.enqueue({
        source: 'manual',
        repo: 'core',
        prompt: 'hello',
      });

      expect(runRepository.markWaitingQueueJob).not.toHaveBeenCalled();
    });

    it('should mark run as errored and re-throw when boss.send fails', async () => {
      const createdRun = {
        id: 'run-abc',
        status: 'waiting',
        source: 'manual',
        repo: 'core',
        prompt: 'do something',
        errorMessage: null,
        completedAt: null,
      };
      (runRepository.create as jest.Mock).mockResolvedValueOnce(createdRun);
      mockBoss.send.mockRejectedValueOnce(new Error('queue unavailable'));

      await expect(
        service.enqueue({
          source: 'manual',
          repo: 'core',
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
          repo: 'core',
          prompt: 'hello',
        }),
      ).rejects.toThrow('DB connection failed');
    });
  });
});
