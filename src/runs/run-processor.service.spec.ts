import { Test } from '@nestjs/testing';
import type {
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { RunProcessorService } from './run-processor.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { LinearCallbackHandlerFactory } from '../callbacks/handlers/linear.callback-handler.js';
import { TracingEnrichmentHandlerFactory } from '../callbacks/handlers/tracing-enrichment.callback-handler.js';
import {
  SdkSessionFactory,
  type SdkSessionHandle,
} from './sdk-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunRepository } from './run.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import { RunEventRepository } from './run-event.repository.js';
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import type { Run } from '../database/runs.schema.js';
import { TelegramService } from '../telegram/telegram.service.js';
import { SlackStreamingCallbackHandlerFactory } from '../slack/slack-streaming.callback-handler.js';
import { AgentProfileService } from '../agents/agent-profile.service.js';
import { ExternalSessionRepository } from './external-session.repository.js';

/** Build a mock SdkSessionHandle whose async generator throws immediately. */
function makeThrowingHandle(error: Error): SdkSessionHandle {
  // eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- intentionally throws before yielding
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    throw error;
  }
  return {
    messages: gen(),
    abort: jest.fn(),
    get sessionId() {
      return undefined;
    },
  } as unknown as SdkSessionHandle;
}

/** Build a mock SdkSessionHandle that delays then throws (for timeout tests). */
function makeDelayedThrowingHandle(delayMs: number): SdkSessionHandle {
  // eslint-disable-next-line require-yield, sonarjs/generator-without-yield -- intentionally throws before yielding
  async function* gen(): AsyncGenerator<SDKMessage, void> {
    await new Promise((_, reject) =>
      setTimeout(reject, delayMs, new Error('aborted')),
    );
  }
  return {
    messages: gen(),
    abort: jest.fn(),
    get sessionId() {
      return undefined;
    },
  } as unknown as SdkSessionHandle;
}

describe('RunProcessorService', () => {
  let service: RunProcessorService;
  let sdkSessionFactory: SdkSessionFactory;
  let activeSessionTracker: ActiveSessionTrackerService;
  let runRepository: RunRepository;
  let runCompletionNotifier: RunCompletionNotifier;
  let runEventRepository: RunEventRepository;
  let linearCallbackHandlerFactory: LinearCallbackHandlerFactory;
  let telegramService: TelegramService;
  let tracingEnrichmentHandlerFactory: TracingEnrichmentHandlerFactory;

  /** Messages that the mock SDK session will yield. Set before calling runSession/processRun. */
  let mockMessages: SDKMessage[];
  /** The mock handle returned by the factory */
  let mockHandle: SdkSessionHandle;
  let mockAbort: jest.Mock;

  const mockGlobalHandler: RunEventHandler = {
    name: 'test-global',
    onMessage: jest.fn(),
  };
  const mockTracingHandler: RunEventHandler = {
    name: 'tracing-enrichment',
    onMessage: jest.fn(),
  };
  const mockTraceContext = {
    traceName: 'manual-run',
    tags: ['source:manual', 'session:ephemeral'],
    metadata: { runId: 'run-123', source: 'manual', repoName: 'my-repo' },
  };

  /** Default successful result message appended to the stream. */
  const defaultResult: SDKResultMessage = {
    type: 'result',
    subtype: 'success',
    result: 'done',
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, output_tokens: 5 } as never,
    modelUsage: {},
    permission_denials: [],
    uuid: '00000000-0000-0000-0000-000000000000' as never,
    session_id: 'test-session',
  };

  function buildMockHandle(): SdkSessionHandle {
    mockAbort = jest.fn();
    const messages = mockMessages;

    async function* generateMessages(): AsyncGenerator<SDKMessage, void> {
      for (const msg of messages) {
        yield msg;
      }
    }

    mockHandle = {
      messages: generateMessages(),
      abort: mockAbort,
      get sessionId() {
        return 'test-session';
      },
    };
    return mockHandle;
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMessages = [defaultResult];

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
          provide: SdkSessionFactory,
          useValue: {
            create: jest
              .fn()
              .mockImplementation(() => Promise.resolve(buildMockHandle())),
          },
        },
        {
          provide: ActiveSessionTrackerService,
          useValue: {
            track: jest.fn(),
            untrack: jest.fn(),
            abort: jest.fn().mockReturnValue(true),
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
          provide: LinearCallbackHandlerFactory,
          useValue: {
            createForRun: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: TelegramService,
          useValue: {
            emitRunResponse: jest.fn().mockResolvedValue(undefined),
            emitRunError: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SlackStreamingCallbackHandlerFactory,
          useValue: {
            createForRun: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: AgentProfileService,
          useValue: {
            getProfile: jest.fn().mockReturnValue(undefined),
          },
        },
        {
          provide: ExternalSessionRepository,
          useValue: {
            findSessionId: jest.fn().mockResolvedValue(null),
            upsertSession: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: TracingEnrichmentHandlerFactory,
          useValue: {
            createForRun: jest.fn().mockReturnValue({
              handler: mockTracingHandler,
              traceContext: mockTraceContext,
            }),
            wrapWithContext: jest.fn(
              async (
                _ctx: unknown,
                fn: () => Promise<unknown>,
              ): Promise<unknown> => await fn(),
            ),
          },
        },
        {
          provide: RUN_EVENT_HANDLERS,
          useValue: [mockGlobalHandler],
        },
      ],
    }).compile();

    service = module.get(RunProcessorService);
    sdkSessionFactory = module.get(SdkSessionFactory);
    activeSessionTracker = module.get(ActiveSessionTrackerService);
    runRepository = module.get(RunRepository);
    runCompletionNotifier = module.get(RunCompletionNotifier);
    runEventRepository = module.get(RunEventRepository);
    linearCallbackHandlerFactory = module.get(LinearCallbackHandlerFactory);
    telegramService = module.get(TelegramService);
    tracingEnrichmentHandlerFactory = module.get(
      TracingEnrichmentHandlerFactory,
    );
  });

  describe('runSession', () => {
    it('should call the factory with cwd + prompt + system prompt', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'do something',
        appendSystemPrompt: 'append',
      });

      expect(sdkSessionFactory.create).toHaveBeenCalledWith({
        cwd: '/home/user/dev/my-repo',
        prompt: 'do something',
        additionalSystemPrompts: ['append'],
        abortController: expect.any(AbortController),
      });
    });

    it('should return success true on completion', async () => {
      const result = await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
      });

      expect(result).toMatchObject({ success: true });
    });

    it('should dispatch messages to all handlers', async () => {
      const assistantMsg: SDKMessage = {
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello', citations: null }],
          model: 'test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never,
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000000' as never,
        session_id: 'test',
      };
      mockMessages = [assistantMsg, defaultResult];

      const additionalHandler: RunEventHandler = {
        name: 'test-additional',
        onMessage: jest.fn(),
      };

      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        additionalHandlers: [additionalHandler],
      });

      // Both global and additional handlers receive all messages
      expect(additionalHandler.onMessage).toHaveBeenCalledWith(assistantMsg);
      expect(additionalHandler.onMessage).toHaveBeenCalledWith(defaultResult);
      expect(mockGlobalHandler.onMessage).toHaveBeenCalledWith(assistantMsg);
      expect(mockGlobalHandler.onMessage).toHaveBeenCalledWith(defaultResult);
    });

    it('should call onComplete for handlers that implement it', async () => {
      const handlerWithComplete: RunEventHandler = {
        name: 'completer',
        onMessage: jest.fn(),
        onComplete: jest.fn(),
      };

      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        additionalHandlers: [handlerWithComplete],
      });

      expect(handlerWithComplete.onComplete).toHaveBeenCalledWith(
        defaultResult,
      );
    });

    it('should call onComplete with undefined when session errors before result', async () => {
      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('boom')),
      );

      const handlerWithComplete: RunEventHandler = {
        name: 'completer',
        onMessage: jest.fn(),
        onComplete: jest.fn(),
      };

      await expect(
        (service as any).runSession({
          cwd: '/home/user/dev/my-repo',
          prompt: 'hello',
          additionalHandlers: [handlerWithComplete],
        }),
      ).rejects.toThrow('boom');

      expect(handlerWithComplete.onComplete).toHaveBeenCalledWith(undefined);
    });

    it('should not crash if a handler throws synchronously', async () => {
      const throwingHandler: RunEventHandler = {
        name: 'throwing-handler',
        onMessage: jest.fn().mockImplementation(() => {
          throw new Error('handler exploded');
        }),
      };
      const safeHandler: RunEventHandler = {
        name: 'safe-handler',
        onMessage: jest.fn(),
      };

      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        additionalHandlers: [throwingHandler, safeHandler],
      });

      expect(safeHandler.onMessage).toHaveBeenCalled();
    });

    it('should not crash if a handler rejects asynchronously', async () => {
      const rejectingHandler: RunEventHandler = {
        name: 'rejecting-handler',
        onMessage: jest.fn().mockRejectedValue(new Error('async boom')),
      };

      const result = await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        additionalHandlers: [rejectingHandler],
      });

      expect(result).toMatchObject({ success: true });
    });

    it('should track and untrack via AbortController', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        externalSessionId: 'linear-session-1',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'linear-session-1',
        expect.any(AbortController),
        undefined,
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        undefined,
      );
    });

    it('should untrack on error', async () => {
      // Make the generator throw
      mockMessages = [];
      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('boom')),
      );

      await expect(
        (service as any).runSession({
          cwd: '/home/user/dev/my-repo',
          prompt: 'hello',
          externalSessionId: 'linear-session-1',
        }),
      ).rejects.toThrow();

      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        undefined,
      );
    });

    it('should not track when no externalSessionId or runId is provided', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
      });

      expect(activeSessionTracker.track).not.toHaveBeenCalled();
      expect(activeSessionTracker.untrack).not.toHaveBeenCalled();
    });

    it('should delegate abort to the tracker', () => {
      service.abortSession('linear-session-1');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith(
        'linear-session-1',
      );
    });

    it('should delegate abortByRunId to the tracker', () => {
      service.abortByRunId('run-123');

      expect(activeSessionTracker.abort).toHaveBeenCalledWith('run-123');
    });

    it('should track by both externalSessionId and runId when both are provided', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        externalSessionId: 'linear-session-1',
        runId: 'run-abc',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'linear-session-1',
        expect.any(AbortController),
        'run-abc',
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'linear-session-1',
        'run-abc',
      );
    });

    it('should track by runId alone when no externalSessionId', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        runId: 'run-abc',
      });

      expect(activeSessionTracker.track).toHaveBeenCalledWith(
        'run-abc',
        expect.any(AbortController),
        'run-abc',
      );
      expect(activeSessionTracker.untrack).toHaveBeenCalledWith(
        'run-abc',
        'run-abc',
      );
    });

    it('should wrap execution in wrapWithContext when trace context is provided', async () => {
      await (service as any).runSession({
        cwd: '/home/user/dev/my-repo',
        prompt: 'hello',
        traceContext: mockTraceContext,
      });

      expect(
        tracingEnrichmentHandlerFactory.wrapWithContext,
      ).toHaveBeenCalledWith(mockTraceContext, expect.any(Function));
    });
  });

  describe('processRun', () => {
    function makeRun(overrides: Partial<Run> = {}): Run {
      return {
        id: 'run-123',
        source: 'manual',
        triggerName: null,
        agentName: null,
        parentRunId: null,
        cwd: '/home/user/dev/my-repo',
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

    it('should skip processing when run is not in waiting status', async () => {
      const run = makeRun({ status: 'succeeded' });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      expect(runRepository.save).not.toHaveBeenCalled();
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
      expect(savedStates[0].status).toBe('running');
      expect(savedStates[0].startedAt).toBeInstanceOf(Date);
      expect(savedStates[0].attemptsMade).toBe(1);
      expect(savedStates[1].status).toBe('succeeded');
      expect(savedStates[1].completedAt).toBeInstanceOf(Date);

      expect(sdkSessionFactory.create).toHaveBeenCalled();
      expect(tracingEnrichmentHandlerFactory.createForRun).toHaveBeenCalledWith(
        run,
      );
    });

    it('should mark run as errored when session throws', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Make session throw
      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('session crashed')),
      );

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

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );

      const lastState = savedStates.at(-1);
      expect(lastState?.status).toBe('errored');
      expect(lastState?.errorMessage).toBe('session crashed');
      expect(lastState?.completedAt).toBeInstanceOf(Date);
    });

    it('should reconstruct LinearCallbackHandler for linear source', async () => {
      const mockLinearHandler = {
        name: 'linear',
        onMessage: jest.fn(),
        onComplete: jest.fn(),
        getLastAssistantMessage: jest.fn().mockReturnValue('Done.'),
        emitResponse: jest.fn().mockResolvedValue(undefined),
        emitError: jest.fn().mockResolvedValue(undefined),
        flush: jest.fn().mockResolvedValue(undefined),
      };
      (linearCallbackHandlerFactory.createForRun as jest.Mock).mockReturnValue(
        mockLinearHandler,
      );
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'my-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      expect(linearCallbackHandlerFactory.createForRun).toHaveBeenCalledWith(
        'my-agent',
        'linear-session-id',
      );
      expect(sdkSessionFactory.create).toHaveBeenCalled();
    });

    it('should not attach linear handler when factory returns undefined', async () => {
      (linearCallbackHandlerFactory.createForRun as jest.Mock).mockReturnValue(
        undefined,
      );
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'missing-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should not re-throw when emitResponse fails on success path', async () => {
      const mockLinearHandler = {
        name: 'linear',
        onMessage: jest.fn(),
        onComplete: jest.fn(),
        getLastAssistantMessage: jest.fn().mockReturnValue('Done.'),
        emitResponse: jest.fn().mockResolvedValue(undefined),
        emitError: jest.fn().mockResolvedValue(undefined),
        flush: jest.fn().mockResolvedValue(undefined),
      };
      (linearCallbackHandlerFactory.createForRun as jest.Mock).mockReturnValue(
        mockLinearHandler,
      );
      const run = makeRun({
        source: 'linear',
        externalSessionId: 'linear-session-id',
        triggerName: 'my-agent',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should emit a Telegram response on successful telegram runs', async () => {
      const run = makeRun({
        source: 'telegram',
        externalSessionId: 'telegram:bot:123:main',
        triggerName: 'daniel-assistant',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Yield an assistant message before the result so AssistantMessageHandler captures it
      const assistantMsg: SDKMessage = {
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'text', text: 'Telegram final reply', citations: null },
          ],
          model: 'test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never,
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000000' as never,
        session_id: 'test',
      };
      mockMessages = [assistantMsg, defaultResult];

      await service.processRun('run-123');

      expect(telegramService.emitRunResponse).toHaveBeenCalledWith(
        'daniel-assistant',
        'telegram:bot:123:main',
        'Telegram final reply',
      );
    });

    it('should emit a Telegram error on failed telegram runs', async () => {
      const run = makeRun({
        source: 'telegram',
        externalSessionId: 'telegram:bot:123:main',
        triggerName: 'daniel-assistant',
      });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Make session throw
      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('telegram crashed')),
      );

      await expect(service.processRun('run-123')).rejects.toThrow(
        'telegram crashed',
      );

      expect(telegramService.emitRunError).toHaveBeenCalledWith(
        'daniel-assistant',
        'telegram:bot:123:main',
        'telegram crashed',
      );
    });

    it('should re-throw original error when save fails in catch block', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('session crashed')),
      );

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

      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('session crashed')),
      );

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );

      expect(runCompletionNotifier.notify).toHaveBeenCalledWith('run-123');
    });

    it('should attach a registry callback handler that writes events to the repo', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      const assistantMsg: SDKMessage = {
        type: 'assistant',
        message: {
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello', citations: null }],
          model: 'test',
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as never,
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000000' as never,
        session_id: 'test',
      };
      const streamMsg: SDKMessage = {
        type: 'stream_event',
        event: {},
        parent_tool_use_id: null,
        uuid: '00000000-0000-0000-0000-000000000000' as never,
        session_id: 'test',
      } as unknown as SDKMessage;
      mockMessages = [assistantMsg, streamMsg, defaultResult];

      await service.processRun('run-123');

      // Registry handler should have persisted assistant and result but NOT stream_event
      const appendCalls = (runEventRepository.append as jest.Mock).mock.calls;
      const persistedTypes = appendCalls.map(
        (call: [string, string, unknown]) => call[1],
      );
      expect(persistedTypes).toContain('assistant');
      expect(persistedTypes).toContain('result');
      expect(persistedTypes).not.toContain('stream_event');
    });

    it('should skip errored write when run is already in terminal state (abort race)', async () => {
      const run = makeRun();
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeThrowingHandle(new Error('session aborted')),
      );

      (runRepository.findById as jest.Mock)
        .mockResolvedValueOnce(run)
        .mockResolvedValueOnce(makeRun({ status: 'aborted' }));

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session aborted',
      );

      const saveCalls = (runRepository.save as jest.Mock).mock.calls;
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0][0].status).toBe('running');
    });

    it('should use run-level timeoutMs when set', async () => {
      const run = makeRun({ timeoutMs: 5000 });
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      await service.processRun('run-123');

      const lastSave = (runRepository.save as jest.Mock).mock.calls.at(-1)?.[0];
      expect(lastSave.status).toBe('succeeded');
    });

    it('should mark run as timed_out when abort signal fires', async () => {
      const run = makeRun({ timeoutMs: 1 }); // 1ms timeout — will fire immediately
      (runRepository.findById as jest.Mock).mockResolvedValue(run);

      // Make the session take long enough for the 1ms timer to fire
      (sdkSessionFactory.create as jest.Mock).mockResolvedValueOnce(
        makeDelayedThrowingHandle(50),
      );

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
