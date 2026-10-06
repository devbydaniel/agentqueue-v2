import { Test } from '@nestjs/testing';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { RunProcessorService } from './run-processor.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunRepository } from './run.repository.js';
import { ExternalSessionRepository } from './external-session.repository.js';
import { RunCompletionNotifier } from './run-completion.notifier.js';
import { RunEventRepository } from './run-event.repository.js';
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type { Run } from '../database/runs.schema.js';
import { RunLifecycleService } from './run-lifecycle.service.js';
import { RunHandlerBuilder } from './run-handler-builder.service.js';
import { RunSourceNotifier } from './run-source-notifier.service.js';
import { LinearCallbackHandlerFactory } from '../callbacks/handlers/linear.callback-handler.js';
import { SlackStreamingCallbackHandlerFactory } from '../slack/slack-streaming.callback-handler.js';
import { MatrixStreamingCallbackHandlerFactory } from '../matrix/matrix-streaming.callback-handler.js';
import { TracingEnrichmentHandlerFactory } from '../callbacks/handlers/tracing-enrichment.callback-handler.js';
import { TelegramService } from '../telegram/telegram.service.js';
import {
  agentSettled,
  assistantError,
  assistantText,
  messageUpdate,
} from '../callbacks/handlers/__tests__/pi-event.fixtures.js';

type Listener = (event: AgentSessionEvent) => void;

/** Stand-in for the slice of pi's AgentSession that RunProcessorService uses. */
function createFakeSession(events: AgentSessionEvent[]) {
  const listeners = new Set<Listener>();
  return {
    sessionId: 'pi-session-1',
    model: { provider: 'anthropic', id: 'claude-opus-5-5' },
    getActiveToolNames: jest.fn(() => ['read', 'bash']),
    subscribe: jest.fn((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    prompt: jest.fn(() => {
      for (const event of events) listeners.forEach((l) => l(event));
      return Promise.resolve();
    }),
    waitForIdle: jest.fn(() => Promise.resolve()),
    abort: jest.fn(() => Promise.resolve()),
  };
}
type FakeSession = ReturnType<typeof createFakeSession>;

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-123',
    source: 'manual',
    triggerName: null,
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

describe('RunProcessorService', () => {
  let service: RunProcessorService;
  let session: FakeSession;
  let factory: { create: jest.Mock; close: jest.Mock };
  let runRepository: { findById: jest.Mock; save: jest.Mock };
  let externalSessionRepository: {
    findSessionId: jest.Mock;
    upsertSession: jest.Mock;
  };
  let runCompletionNotifier: { notify: jest.Mock };
  let runEventAppend: jest.Mock;
  let telegramService: { emitRunResponse: jest.Mock; emitRunError: jest.Mock };
  let linearFactory: { createForRun: jest.Mock };
  let slackFactory: { createForRun: jest.Mock };
  let matrixFactory: { createForRun: jest.Mock };
  let tracingFactory: { createForRun: jest.Mock; wrapWithContext: jest.Mock };
  /** Snapshot of every saved run, since the service mutates one Run object. */
  let saved: Run[];

  const traceContext = {
    traceName: 'manual-run',
    tags: ['source:manual'],
    metadata: { runId: 'run-123' },
  };

  function givenRun(overrides: Partial<Run> = {}): Run {
    const run = makeRun(overrides);
    runRepository.findById.mockResolvedValue(run);
    return run;
  }

  function givenPromptFails(message: string): void {
    session.prompt.mockRejectedValue(new Error(message));
  }

  /** A source-channel handler double exposing the notifier's delivery API. */
  function sourceHandler(name: string) {
    return {
      name,
      onEvent: jest.fn(),
      getLastAssistantMessage: jest.fn().mockReturnValue('Done.'),
      emitResponse: jest.fn().mockResolvedValue(undefined),
      emitError: jest.fn().mockResolvedValue(undefined),
      finalize: jest.fn().mockResolvedValue(undefined),
    };
  }

  beforeEach(async () => {
    saved = [];
    session = createFakeSession([assistantText('Final reply'), agentSettled()]);
    factory = {
      create: jest.fn(() => Promise.resolve(session)),
      close: jest.fn().mockResolvedValue(undefined),
    };
    runRepository = {
      findById: jest.fn(),
      save: jest.fn((run: Run) => {
        saved.push({ ...run });
        return Promise.resolve();
      }),
    };
    externalSessionRepository = {
      findSessionId: jest.fn().mockResolvedValue(null),
      upsertSession: jest.fn().mockResolvedValue(undefined),
    };
    runCompletionNotifier = { notify: jest.fn().mockResolvedValue(undefined) };
    runEventAppend = jest.fn().mockResolvedValue(undefined);
    telegramService = {
      emitRunResponse: jest.fn().mockResolvedValue(undefined),
      emitRunError: jest.fn().mockResolvedValue(undefined),
    };
    linearFactory = { createForRun: jest.fn() };
    slackFactory = { createForRun: jest.fn() };
    matrixFactory = { createForRun: jest.fn() };
    tracingFactory = {
      createForRun: jest.fn().mockReturnValue({
        handler: { name: 'tracing-enrichment', onEvent: jest.fn() },
        traceContext,
      }),
      wrapWithContext: jest.fn((_ctx: unknown, fn: () => Promise<unknown>) =>
        fn(),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        RunProcessorService,
        RunLifecycleService,
        RunHandlerBuilder,
        RunSourceNotifier,
        ActiveSessionTrackerService,
        { provide: AppConfigService, useValue: { runTimeoutMs: 1_800_000 } },
        { provide: PiSessionFactory, useValue: factory },
        { provide: RunRepository, useValue: runRepository },
        {
          provide: ExternalSessionRepository,
          useValue: externalSessionRepository,
        },
        { provide: RunCompletionNotifier, useValue: runCompletionNotifier },
        {
          provide: RunEventRepository,
          useValue: { append: runEventAppend },
        },
        { provide: LinearCallbackHandlerFactory, useValue: linearFactory },
        {
          provide: SlackStreamingCallbackHandlerFactory,
          useValue: slackFactory,
        },
        {
          provide: MatrixStreamingCallbackHandlerFactory,
          useValue: matrixFactory,
        },
        { provide: TracingEnrichmentHandlerFactory, useValue: tracingFactory },
        { provide: TelegramService, useValue: telegramService },
        { provide: RUN_EVENT_HANDLERS, useValue: [] },
      ],
    }).compile();

    service = module.get(RunProcessorService);
  });

  describe('lifecycle', () => {
    it('skips runs that are not waiting', async () => {
      givenRun({ status: 'succeeded' });

      await service.processRun('run-123');

      expect(runRepository.save).not.toHaveBeenCalled();
      expect(factory.create).not.toHaveBeenCalled();
    });

    it('throws when the run does not exist', async () => {
      runRepository.findById.mockResolvedValue(null);

      await expect(service.processRun('nonexistent')).rejects.toThrow(
        'Run nonexistent not found',
      );
    });

    it('marks the run running, runs the session, then marks it succeeded', async () => {
      const run = givenRun({ attemptsMade: 2, appendSystemPrompt: 'extra' });

      await service.processRun('run-123');

      expect(saved.map((r) => r.status)).toEqual(['running', 'succeeded']);
      expect(saved[0].startedAt).toBeInstanceOf(Date);
      expect(saved[0].attemptsMade).toBe(3);
      expect(saved[1].completedAt).toBeInstanceOf(Date);
      expect(factory.create).toHaveBeenCalledWith({
        cwd: run.cwd,
        runId: 'run-123',
        additionalSystemPrompts: ['extra'],
        resumeSessionId: undefined,
      });
      expect(session.prompt).toHaveBeenCalledWith('do something');
      expect(factory.close).toHaveBeenCalledWith(session);
      expect(runCompletionNotifier.notify).toHaveBeenCalledWith('run-123');
    });

    it('resumes the stored pi session and upserts the new session id', async () => {
      givenRun({ source: 'linear', externalSessionId: 'linear-session-id' });
      externalSessionRepository.findSessionId.mockResolvedValue('pi-prev');

      await service.processRun('run-123');

      expect(externalSessionRepository.findSessionId).toHaveBeenCalledWith(
        'linear-session-id',
      );
      expect(factory.create).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: 'pi-prev' }),
      );
      expect(externalSessionRepository.upsertSession).toHaveBeenCalledWith({
        provider: 'linear',
        sessionKey: 'linear-session-id',
        sessionId: 'pi-session-1',
      });
    });

    it('does not upsert an external session for runs without one', async () => {
      givenRun();

      await service.processRun('run-123');

      expect(externalSessionRepository.upsertSession).not.toHaveBeenCalled();
    });

    it('marks the run errored when the prompt throws', async () => {
      givenRun();
      givenPromptFails('session crashed');

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );

      const last = saved.at(-1);
      expect(last?.status).toBe('errored');
      expect(last?.errorMessage).toBe('session crashed');
      expect(last?.completedAt).toBeInstanceOf(Date);
      expect(factory.close).toHaveBeenCalledWith(session);
      expect(runCompletionNotifier.notify).toHaveBeenCalledWith('run-123');
    });

    it('marks the run errored when the agent ends on a provider error', async () => {
      givenRun();
      session = createFakeSession([assistantError('overloaded')]);

      await expect(service.processRun('run-123')).rejects.toThrow(
        'Agent run failed: overloaded',
      );

      expect(saved.at(-1)?.status).toBe('errored');
      expect(saved.at(-1)?.errorMessage).toBe('Agent run failed: overloaded');
    });

    it.each([
      ['resolves', () => Promise.resolve()],
      ['rejects', () => Promise.reject(new Error('abort failed'))],
    ])(
      'aborts the session and marks the run timed_out when the timeout fires (abort %s)',
      async (_label, abortOutcome) => {
        givenRun({ timeoutMs: 1 });
        session.prompt.mockImplementation(
          () =>
            new Promise<void>((resolve) =>
              session.abort.mockImplementation(() => {
                resolve();
                return abortOutcome();
              }),
            ),
        );

        await expect(service.processRun('run-123')).rejects.toThrow(
          'Agent run aborted',
        );

        expect(session.abort).toHaveBeenCalled();
        expect(saved.at(-1)?.status).toBe('timed_out');
        expect(saved.at(-1)?.errorMessage).toBe('Run timed out after 1ms');
      },
    );

    it('skips the errored write when the run is already terminal (abort race)', async () => {
      const run = givenRun();
      runRepository.findById
        .mockResolvedValueOnce(run)
        .mockResolvedValueOnce(makeRun({ status: 'aborted' }));
      givenPromptFails('session aborted');

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session aborted',
      );

      expect(saved.map((r) => r.status)).toEqual(['running']);
    });

    it('re-throws the original error when saving the error status fails', async () => {
      givenRun();
      givenPromptFails('session crashed');
      runRepository.save
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('DB write failed'));

      await expect(service.processRun('run-123')).rejects.toThrow(
        'session crashed',
      );
    });

    it('wraps the session in the run trace context', async () => {
      const run = givenRun();

      await service.processRun('run-123');

      expect(tracingFactory.createForRun).toHaveBeenCalledWith(run);
      expect(tracingFactory.wrapWithContext).toHaveBeenCalledWith(
        traceContext,
        expect.any(Function),
      );
    });

    it('persists session events through the run-event handler', async () => {
      givenRun();
      session = createFakeSession([
        messageUpdate(),
        assistantText('hello'),
        agentSettled(),
      ]);

      await service.processRun('run-123');

      const persisted = runEventAppend.mock.calls.map((call) => call[1]);
      expect(persisted).toEqual(['session_start', 'message:assistant']);
      expect(runEventAppend).toHaveBeenCalledWith('run-123', 'session_start', {
        sessionId: 'pi-session-1',
        model: 'anthropic/claude-opus-5-5',
        tools: ['read', 'bash'],
      });
    });
  });

  describe('source notifications', () => {
    const linearRun: Partial<Run> = {
      source: 'linear',
      externalSessionId: 'linear-session-id',
      triggerName: 'my-agent',
    };
    const telegramRun: Partial<Run> = {
      source: 'telegram',
      externalSessionId: 'telegram:bot:123:main',
      triggerName: 'daniel-assistant',
    };

    it('emits the last assistant message to Linear on success', async () => {
      const linear = sourceHandler('linear');
      linearFactory.createForRun.mockReturnValue(linear);
      givenRun(linearRun);

      await service.processRun('run-123');

      expect(linearFactory.createForRun).toHaveBeenCalledWith(
        'my-agent',
        'linear-session-id',
      );
      expect(linear.onEvent).toHaveBeenCalledTimes(2);
      expect(linear.emitResponse).toHaveBeenCalledWith('Done.');
    });

    it('emits the error to Linear on failure', async () => {
      const linear = sourceHandler('linear');
      linearFactory.createForRun.mockReturnValue(linear);
      givenRun(linearRun);
      givenPromptFails('linear crashed');

      await expect(service.processRun('run-123')).rejects.toThrow();

      expect(linear.emitError).toHaveBeenCalledWith('linear crashed');
    });

    it('still succeeds when the Linear agent is not configured', async () => {
      linearFactory.createForRun.mockReturnValue(undefined);
      givenRun(linearRun);

      await service.processRun('run-123');

      expect(saved.at(-1)?.status).toBe('succeeded');
    });

    it('does not fail the run when Linear delivery fails', async () => {
      const linear = sourceHandler('linear');
      linear.emitResponse.mockRejectedValue(new Error('Linear down'));
      linearFactory.createForRun.mockReturnValue(linear);
      givenRun(linearRun);

      await service.processRun('run-123');

      expect(saved.at(-1)?.status).toBe('succeeded');
    });

    it('sends the final assistant text as the Telegram reply', async () => {
      givenRun(telegramRun);

      await service.processRun('run-123');

      expect(telegramService.emitRunResponse).toHaveBeenCalledWith(
        'daniel-assistant',
        'telegram:bot:123:main',
        'Final reply',
      );
    });

    it('sends the error as the Telegram reply on failure', async () => {
      givenRun(telegramRun);
      givenPromptFails('telegram crashed');

      await expect(service.processRun('run-123')).rejects.toThrow();

      expect(telegramService.emitRunError).toHaveBeenCalledWith(
        'daniel-assistant',
        'telegram:bot:123:main',
        'telegram crashed',
      );
    });

    it.each([
      ['slack' as const, () => slackFactory],
      ['matrix' as const, () => matrixFactory],
    ])(
      'finalizes the %s stream on success and emits errors on failure',
      async (source, getFactory) => {
        const handler = sourceHandler(source);
        getFactory().createForRun.mockReturnValue(handler);
        const run = { source, externalSessionId: 'thread-1', triggerName: 'a' };

        givenRun(run);
        await service.processRun('run-123');
        expect(handler.finalize).toHaveBeenCalled();

        givenRun(run);
        givenPromptFails(`${source} crashed`);
        await expect(service.processRun('run-123')).rejects.toThrow();
        expect(handler.emitError).toHaveBeenCalledWith(`${source} crashed`);
      },
    );
  });
});
