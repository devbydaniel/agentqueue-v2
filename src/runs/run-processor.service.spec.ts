import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import { RunProcessorService } from './run-processor.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { AgentfilesConfigService } from '../config/agentfiles-config.service.js';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import { RunEventRepository } from './run-event.repository.js';
import { CALLBACK_HANDLERS } from '../callbacks/constants.js';
import type { CallbackHandler } from '../callbacks/callback-handler.interface.js';
import type { Run } from '../database/runs.schema.js';

/** Prompt mock that delays 50ms then rejects — used to test timeout behavior */
function delayedReject(): Promise<void> {
  return new Promise((_, reject) =>
    setTimeout(reject, 50, new Error('aborted')),
  );
}

describe('RunProcessorService', () => {
  let service: RunProcessorService;
  let configService: AgentfilesConfigService;
  let piSessionFactory: PiSessionFactory;
  let activeSessionTracker: ActiveSessionTrackerService;
  let runRepository: RunRepository;
  let runCompletionNotifier: RunCompletionNotifier;
  let runEventRepository: RunEventRepository;
  let triggerConfigService: TriggerConfigService;
  let mockSession: jest.Mocked<
    Pick<AgentSession, 'prompt' | 'subscribe' | 'abort'>
  > & {
    dispose: jest.Mock;
  };
  let mockDispose: jest.Mock;
  let subscribeFn: ((event: unknown) => void) | undefined;

  const mockGlobalHandler: CallbackHandler = {
    name: 'test-global',
    onEvent: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    subscribeFn = undefined;

    const unsubscribe = jest.fn();
    mockSession = {
      prompt: jest.fn().mockResolvedValue(undefined),
      subscribe: jest
        .fn()
        .mockImplementation((fn: (event: unknown) => void) => {
          subscribeFn = fn;
          return unsubscribe;
        }),
      abort: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn(),
    };
    mockDispose = jest.fn();

    const module = await Test.createTestingModule({
      providers: [
        RunProcessorService,
        {
          provide: AppConfigService,
          useValue: {
            runTimeoutMs: 1800000,
          },
        },
        {
          provide: AgentfilesConfigService,
          useValue: {
            resolveRepo: jest.fn().mockReturnValue('/home/user/dev/my-repo'),
          },
        },
        {
          provide: PiSessionFactory,
          useValue: {
            create: jest.fn().mockResolvedValue({
              session: mockSession,
              dispose: mockDispose,
            }),
          },
        },
        {
          provide: ActiveSessionTrackerService,
          useValue: {
            track: jest.fn(),
            untrack: jest.fn(),
            abort: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: RunRepository,
          useValue: {
            findById: jest.fn(),
            save: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RunCompletionNotifier,
          useValue: {
            notify: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: RunEventRepository,
          useValue: {
            append: jest.fn().mockResolvedValue(undefined),
            findByRunId: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: TriggerConfigService,
          useValue: {
            getLinearTrigger: jest.fn(),
          },
        },
        {
          provide: CALLBACK_HANDLERS,
          useValue: [mockGlobalHandler],
        },
      ],
    }).compile();

    service = module.get(RunProcessorService);
    configService = module.get(AgentfilesConfigService);
    piSessionFactory = module.get(PiSessionFactory);
    activeSessionTracker = module.get(ActiveSessionTrackerService);
    runRepository = module.get(RunRepository);
    runCompletionNotifier = module.get(RunCompletionNotifier);
    runEventRepository = module.get(RunEventRepository);
    triggerConfigService = module.get(TriggerConfigService);
  });

  describe('runSession', () => {
    it('should resolve the repo via config service', async () => {
      await service.runSession({ repo: 'core', prompt: 'do something' });

      expect(configService.resolveRepo).toHaveBeenCalledWith('core');
    });

    it('should call the factory with cwd + system prompt options', async () => {
      await service.runSession({
        repo: 'core',
        prompt: 'do something',
        externalSessionId: 'session-1',
        prependSystemPrompt: 'prepend',
        appendSystemPrompt: 'append',
      });

      expect(piSessionFactory.create).toHaveBeenCalledWith({
        cwd: '/home/user/dev/my-repo',
        externalSessionId: 'session-1',
        prependSystemPrompt: 'prepend',
        appendSystemPrompt: 'append',
      });
    });

    it('should call session.prompt with the provided prompt', async () => {
      await service.runSession({ repo: 'core', prompt: 'fix the tests' });

      expect(mockSession.prompt).toHaveBeenCalledWith('fix the tests');
    });

    it('should return success true on completion', async () => {
      const result = await service.runSession({
        repo: 'core',
        prompt: 'hello',
      });

      expect(result).toEqual({ success: true });
    });

    it('should call dispose() on success', async () => {
      await service.runSession({ repo: 'core', prompt: 'hello' });

      expect(mockDispose).toHaveBeenCalled();
    });

    it('should call dispose() on error', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.runSession({ repo: 'core', prompt: 'hello' }),
      ).rejects.toThrow();

      expect(mockDispose).toHaveBeenCalled();
    });

    it('should propagate NotFoundException from resolveRepo unchanged', async () => {
      (configService.resolveRepo as jest.Mock).mockImplementation(() => {
        throw new NotFoundException('Repo "unknown" not found');
      });

      await expect(
        service.runSession({ repo: 'unknown', prompt: 'hello' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should propagate unknown errors from session.prompt unchanged', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('something broke'));

      await expect(
        service.runSession({ repo: 'core', prompt: 'hello' }),
      ).rejects.toThrow('something broke');
    });

    it('should call additionalHandlers on session events', async () => {
      const additionalHandler: CallbackHandler = {
        name: 'test-additional',
        onEvent: jest.fn(),
      };

      mockSession.prompt.mockImplementationOnce(async () => {
        subscribeFn?.({ type: 'agent_start' });
      });

      await service.runSession({
        repo: 'core',
        prompt: 'hello',
        additionalHandlers: [additionalHandler],
      });

      expect(additionalHandler.onEvent).toHaveBeenCalledWith({
        type: 'agent_start',
      });
      expect(mockGlobalHandler.onEvent).toHaveBeenCalledWith({
        type: 'agent_start',
      });
    });

    it('should not crash if a handler throws synchronously', async () => {
      const throwingHandler: CallbackHandler = {
        name: 'throwing-handler',
        onEvent: jest.fn().mockImplementation(() => {
          throw new Error('handler exploded');
        }),
      };
      const safeHandler: CallbackHandler = {
        name: 'safe-handler',
        onEvent: jest.fn(),
      };

      mockSession.prompt.mockImplementationOnce(async () => {
        subscribeFn?.({ type: 'agent_start' });
      });

      const result = await service.runSession({
        repo: 'core',
        prompt: 'hello',
        additionalHandlers: [throwingHandler, safeHandler],
      });

      expect(result).toEqual({ success: true });
      expect(safeHandler.onEvent).toHaveBeenCalled();
    });

    it('should not crash if a handler rejects asynchronously', async () => {
      const rejectingHandler: CallbackHandler = {
        name: 'rejecting-handler',
        onEvent: jest.fn().mockRejectedValue(new Error('async boom')),
      };

      mockSession.prompt.mockImplementationOnce(async () => {
        subscribeFn?.({ type: 'agent_start' });
      });

      const result = await service.runSession({
        repo: 'core',
        prompt: 'hello',
        additionalHandlers: [rejectingHandler],
      });

      expect(result).toEqual({ success: true });
    });

    it('should track and untrack active session via tracker', async () => {
      await service.runSession({
        repo: 'core',
        prompt: 'hello',
        externalSessionId: 'linear-session-1',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'linear-session-1',
        mockSession,
        undefined,
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        undefined,
      );
    });

    it('should untrack on error', async () => {
      mockSession.prompt.mockRejectedValueOnce(new Error('boom'));

      await expect(
        service.runSession({
          repo: 'core',
          prompt: 'hello',
          externalSessionId: 'linear-session-1',
        }),
      ).rejects.toThrow();

      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        undefined,
      );
    });

    it('should not track when no externalSessionId is provided', async () => {
      await service.runSession({ repo: 'core', prompt: 'hello' });

      expect(activeSessionTracker.track).not.toHaveBeenCalled();
      expect(activeSessionTracker.untrack).not.toHaveBeenCalled();
    });

    it('should delegate abort to the tracker', async () => {
      await service.abortSession('linear-session-1');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });

    it('should delegate abortByRunId to the tracker', async () => {
      await service.abortByRunId('run-123');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith('run-123');
    });

    it('should track by both externalSessionId and runId when both are provided', async () => {
      await service.runSession({
        repo: 'core',
        prompt: 'hello',
        externalSessionId: 'linear-session-1',
        runId: 'run-abc',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'linear-session-1',
        mockSession,
        'run-abc',
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        'run-abc',
      );
    });

    it('should track by runId alone when no externalSessionId', async () => {
      await service.runSession({
        repo: 'core',
        prompt: 'hello',
        runId: 'run-abc',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'run-abc',
        mockSession,
        'run-abc',
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'run-abc',
        'run-abc',
      );
    });
  });

  describe('processRun', () => {
    function makeRun(overrides: Partial<Run> = {}): Run {
      return {
        id: 'run-123',
        source: 'manual',
        triggerName: null,
        parentFlowRunId: null,
        repo: 'core',
        prompt: 'do something',
        promptPreview: 'do something',
        status: 'waiting',
        attemptsMade: 0,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        externalSessionId: null,
        prependSystemPrompt: null,
        appendSystemPrompt: null,
        timeoutMs: null,
        queueJobId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      };
    }

    it('should skip processing when run is not in waiting status', async () => {
      const run = makeRun({ status: 'succeeded' });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      expect(runRepository.save).not.toHaveBeenCalled();
      expect(mockSession.prompt).not.toHaveBeenCalled();
    });

    it('should throw when run is not found', async () => {
      (runRepository.findById as jest.Mock).mockResolvedValue(null);

      await expect(service.processRun('nonexistent')).rejects.toThrow(
        'Run nonexistent not found',
      );
    });

    it('should mark run as running, execute session, then mark succeeded', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Capture state at each save call since the object is mutated in place
      const savedStates: Array<{
        status: string;
        startedAt: Date | null;
        completedAt: Date | null;
        attemptsMade: number;
      }> = [];
      (runRepository.save as jest.Mock).mockImplementation((r: Run) => {
        savedStates.push({
          status: r.status,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          attemptsMade: r.attemptsMade,
        });
        return Promise.resolve();
      });

      await service.processRun('run-123');

      expect(savedStates).toHaveLength(2);
      // First save: mark running
      expect(savedStates[0].status).toBe('running');
      expect(savedStates[0].startedAt).toBeInstanceOf(Date);
      expect(savedStates[0].attemptsMade).toBe(1);
      // Second save: mark succeeded
      expect(savedStates[1].status).toBe('succeeded');
      expect(savedStates[1].completedAt).toBeInstanceOf(Date);

      // Session was prompted
      expect(mockSession.prompt).toHaveBeenCalledWith('do something');
    });

    it('should mark run as errored when session throws', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      const savedStates: Array<{
        status: string;
        errorMessage: string | null;
        completedAt: Date | null;
      }> = [];
      (runRepository.save as jest.Mock).mockImplementation((r: Run) => {
        savedStates.push({
          status: r.status,
          errorMessage: r.errorMessage,
          completedAt: r.completedAt,
        });
        return Promise.resolve();
      });

      mockSession.prompt.mockRejectedValueOnce(new Error('session crashed'));

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );

      const lastState = savedStates.at(-1);
      expect(lastState?.status).toBe('errored');
      expect(lastState?.errorMessage).toBe('session crashed');
      expect(lastState?.completedAt).toBeInstanceOf(Date);
    });

    it('should reconstruct LinearCallbackHandler for linear source', async () => {
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'my-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      (triggerConfigService.getLinearTrigger as jest.Mock).mockReturnValue({
        name: 'my-agent',
        type: 'linear',
        target: 'core',
        signing_secret: 'secret',
        api_key: 'test-api-key',
      });

      await service.processRun('run-123');

      // Verify factory was called with externalSessionId
      expect(piSessionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ externalSessionId: 'linear-session-id' }),
      );

      // The linear handler should have been attached — we can verify
      // by checking subscribe was called (handlers were attached)
      expect(mockSession.subscribe).toHaveBeenCalled();
    });

    it('should not attach linear handler when trigger config not found', async () => {
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'missing-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      (triggerConfigService.getLinearTrigger as jest.Mock).mockReturnValue(
        undefined,
      );

      await service.processRun('run-123');

      // Should still succeed — just without the Linear handler
      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should not re-throw when emitResponse fails on success path', async () => {
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'my-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      (triggerConfigService.getLinearTrigger as jest.Mock).mockReturnValue({
        name: 'my-agent',
        type: 'linear',
        target: 'core',
        signing_secret: 'secret',
        api_key: 'test-api-key',
      });

      // The run should still succeed even though emitResponse would fail
      // (LinearCallbackHandler is constructed internally; we verify the run
      // completes as succeeded despite any Linear API issues)
      await service.processRun('run-123');

      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should re-throw original error when save fails in catch block', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      mockSession.prompt.mockRejectedValueOnce(new Error('session crashed'));

      // First save (mark running) succeeds, second save (mark errored) fails
      (runRepository.save as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB write failed'));

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );
    });

    it('should notify on successful completion', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      expect(runCompletionNotifier.notify).toHaveBeenCalledWith('run-123');
    });

    it('should notify on error completion', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      mockSession.prompt.mockRejectedValueOnce(new Error('session crashed'));

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );

      expect(runCompletionNotifier.notify).toHaveBeenCalledWith('run-123');
    });

    it('should attach a registry callback handler that writes events to the repo', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      mockSession.prompt.mockImplementationOnce(async () => {
        // Simulate a session event while prompt is running
        subscribeFn?.({ type: 'agent_start' });
        subscribeFn?.({ type: 'message_update', content: 'noisy' });
        subscribeFn?.({ type: 'turn_end', toolResults: [] });
      });

      await service.processRun('run-123');

      // Registry handler should have persisted agent_start and turn_end but NOT message_update
      const appendCalls = (runEventRepository.append as jest.Mock).mock.calls;
      const persistedTypes = appendCalls.map(
        (call: [string, string, unknown]) => call[1],
      );
      expect(persistedTypes).toContain('agent_start');
      expect(persistedTypes).toContain('turn_end');
      expect(persistedTypes).not.toContain('message_update');
    });

    it('should skip errored write when run is already in terminal state (abort race)', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);
      mockSession.prompt.mockRejectedValueOnce(new Error('session aborted'));

      // On the second findById call (in the catch block), return a run that's already aborted
      (runRepository.findById as jest.Mock)
        .mockResolvedValueOnce(run) // first call in processRun
        .mockResolvedValueOnce(makeRun({ status: 'aborted' })); // re-read in catch

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session aborted',
      );

      // save should only be called once (mark running), NOT for errored
      const saveCalls = (runRepository.save as jest.Mock).mock.calls;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0][0].status).toBe('running');
    });

    it('should use run-level timeoutMs when set', async () => {
      const run = makeRun({ timeoutMs: 5000 });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      // Run succeeds normally — just verify it doesn't crash with a custom timeout
      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should mark run as timed_out when abort signal fires', async () => {
      const run = makeRun({ timeoutMs: 1 }); // 1ms timeout — will fire immediately
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Make prompt hang longer than the 1ms timeout, then reject
      mockSession.prompt.mockImplementation(delayedReject);

      await expect(service.processRun('run-123')).rejects.toThrow();

      const savedStates = (runRepository.save as jest.Mock).mock.calls.map(
        (call: [Run]) => ({
          status: call[0].status,
          errorMessage: call[0].errorMessage,
        }),
      );
      const lastState = savedStates.at(-1);
      expect(lastState?.status).toBe('timed_out');
      expect(lastState?.errorMessage).toContain('timed out');
    });

    it('should increment attemptsMade on each processRun call', async () => {
      const run = makeRun({ attemptsMade: 2 });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      const firstSave = (runRepository.save as jest.Mock).mock.calls[0][0];
      expect(firstSave.attemptsMade).toBe(3);
    });
  });
});
