import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { RunProcessorService } from './run-processor.service.js';
import { PiSessionFactory } from './pi-session.factory.js';
import { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import { RunLifecycleService } from './run-lifecycle.service.js';
import { RunHandlerBuilder } from './run-handler-builder.service.js';
import { RunSourceNotifier } from './run-source-notifier.service.js';
import { RUN_EVENT_HANDLERS } from '../callbacks/constants.js';
import type { RunEventHandler } from '../callbacks/run-event-handler.interface.js';
import {
  agentSettled,
  assistantError,
  assistantText,
  assistantToolCall,
  toolResult,
} from '../callbacks/handlers/__tests__/pi-event.fixtures.js';

type Listener = (event: AgentSessionEvent) => void;

/** Stand-in for the slice of pi's AgentSession that RunProcessorService uses. */
function createFakeSession(events: AgentSessionEvent[] = []) {
  const listeners = new Set<Listener>();
  const emit = (event: AgentSessionEvent) => {
    for (const listener of listeners) listener(event);
  };
  return {
    sessionId: 'pi-session-1',
    model: { provider: 'anthropic', id: 'claude-opus-5-5' } as
      | { provider: string; id: string }
      | undefined,
    getActiveToolNames: jest.fn(() => ['read', 'bash']),
    subscribe: jest.fn((listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    prompt: jest.fn(() => {
      events.forEach(emit);
      return Promise.resolve();
    }),
    waitForIdle: jest.fn(() => Promise.resolve()),
    abort: jest.fn(() => Promise.resolve()),
    emit,
  };
}
type FakeSession = ReturnType<typeof createFakeSession>;

/** Make prompt() hang until session.abort() is called, like a live agent turn. */
function promptUntilAborted(
  session: FakeSession,
  abortOutcome: () => Promise<void> = () => Promise.resolve(),
): void {
  let release: (() => void) | undefined;
  session.prompt.mockImplementation(
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  session.abort.mockImplementation(() => {
    release?.();
    return abortOutcome();
  });
}

function recordingHandler(name: string, log: string[]): RunEventHandler {
  return {
    name,
    onStart: jest.fn(() => {
      log.push(`${name}:start`);
    }),
    onEvent: jest.fn((event: AgentSessionEvent) => {
      log.push(`${name}:${event.type}`);
    }),
    onComplete: jest.fn(() => {
      log.push(`${name}:complete`);
    }),
  };
}

describe('RunProcessorService session handling', () => {
  let service: RunProcessorService;
  let tracker: ActiveSessionTrackerService;
  let session: FakeSession;
  let factory: { create: jest.Mock; close: jest.Mock };
  let wrapWithTraceContext: jest.Mock;
  let globalHandler: RunEventHandler;
  let log: string[];

  const runSession = (params: Record<string, unknown> = {}) =>
    (service as any).runSession({
      cwd: '/home/user/dev/my-repo',
      prompt: 'do something',
      ...params,
    });

  beforeEach(async () => {
    log = [];
    session = createFakeSession([assistantText('Hello'), agentSettled()]);
    factory = {
      create: jest.fn(() => Promise.resolve(session)),
      close: jest.fn().mockResolvedValue(undefined),
    };
    wrapWithTraceContext = jest.fn((_ctx: unknown, fn: () => Promise<void>) =>
      fn(),
    );
    globalHandler = recordingHandler('global', log);

    const module = await Test.createTestingModule({
      providers: [
        RunProcessorService,
        ActiveSessionTrackerService,
        { provide: PiSessionFactory, useValue: factory },
        { provide: RunLifecycleService, useValue: {} },
        { provide: RunHandlerBuilder, useValue: { wrapWithTraceContext } },
        { provide: RunSourceNotifier, useValue: {} },
        { provide: RUN_EVENT_HANDLERS, useValue: [globalHandler] },
      ],
    }).compile();

    service = module.get(RunProcessorService);
    tracker = module.get(ActiveSessionTrackerService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('session creation', () => {
    it('passes cwd, runId, resumeSessionId and the appended system prompt to create()', async () => {
      await runSession({
        runId: 'run-1',
        resumeSessionId: 'pi-prev',
        appendSystemPrompt: 'be brief',
      });

      expect(factory.create).toHaveBeenCalledWith({
        cwd: '/home/user/dev/my-repo',
        runId: 'run-1',
        additionalSystemPrompts: ['be brief'],
        resumeSessionId: 'pi-prev',
      });
    });

    it('omits additionalSystemPrompts when nothing is appended', async () => {
      await runSession();

      expect(factory.create).toHaveBeenCalledWith(
        expect.objectContaining({ additionalSystemPrompts: undefined }),
      );
    });

    it('prompts with the run prompt and returns the pi session id', async () => {
      await expect(runSession()).resolves.toEqual({
        sessionId: 'pi-session-1',
      });
      expect(session.prompt).toHaveBeenCalledWith('do something');
    });
  });

  describe('handler dispatch', () => {
    it('dispatches events to global then additional handlers in emission order', async () => {
      await runSession({
        additionalHandlers: [recordingHandler('extra', log)],
      });

      expect(log).toEqual([
        'global:start',
        'extra:start',
        'global:message_end',
        'extra:message_end',
        'global:agent_settled',
        'extra:agent_settled',
        'global:complete',
        'extra:complete',
      ]);
    });

    it('awaits async handlers one event at a time, in order, before completing', async () => {
      const slow: RunEventHandler = {
        name: 'slow',
        onEvent: async (event) => {
          log.push(`begin:${event.type}`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          log.push(`end:${event.type}`);
        },
      };

      await runSession({ additionalHandlers: [slow] });

      expect(log.filter((entry) => !entry.startsWith('global'))).toEqual([
        'begin:message_end',
        'end:message_end',
        'begin:agent_settled',
        'end:agent_settled',
      ]);
    });

    it('calls onStart with session info before prompting', async () => {
      await runSession();

      expect(globalHandler.onStart).toHaveBeenCalledWith({
        sessionId: 'pi-session-1',
        model: 'anthropic/claude-opus-5-5',
        tools: ['read', 'bash'],
      });
      const onStart = globalHandler.onStart as jest.Mock;
      expect(onStart.mock.invocationCallOrder[0]).toBeLessThan(
        session.prompt.mock.invocationCallOrder[0],
      );
    });

    it('reports an undefined model when the session has none', async () => {
      session.model = undefined;

      await runSession();

      expect(globalHandler.onStart).toHaveBeenCalledWith(
        expect.objectContaining({ model: undefined }),
      );
    });

    it('dispatches events emitted while waiting for idle, after prompt settles', async () => {
      session.waitForIdle.mockImplementation(() => {
        session.emit(assistantText('follow-up'));
        return Promise.resolve();
      });

      await runSession();

      expect(session.waitForIdle.mock.invocationCallOrder[0]).toBeGreaterThan(
        session.prompt.mock.invocationCallOrder[0],
      );
      expect(log).toEqual([
        'global:start',
        'global:message_end',
        'global:agent_settled',
        'global:message_end',
        'global:complete',
      ]);
    });

    it('stops dispatching once the session has finished', async () => {
      await runSession();
      session.emit(agentSettled());

      expect(globalHandler.onEvent).toHaveBeenCalledTimes(2);
    });

    it('keeps calling other handlers when one throws or rejects', async () => {
      const throwing: RunEventHandler = {
        name: 'throwing',
        onStart: () => {
          throw new Error('start exploded');
        },
        onEvent: () => {
          throw new Error('handler exploded');
        },
        onComplete: () => Promise.reject(new Error('complete exploded')),
      };
      const rejecting: RunEventHandler = {
        name: 'rejecting',
        onEvent: () => Promise.reject(new Error('async boom')),
      };
      const safe = recordingHandler('safe', log);

      await expect(
        runSession({ additionalHandlers: [throwing, rejecting, safe] }),
      ).resolves.toEqual({ sessionId: 'pi-session-1' });

      expect(log.filter((entry) => entry.startsWith('safe'))).toEqual([
        'safe:start',
        'safe:message_end',
        'safe:agent_settled',
        'safe:complete',
      ]);
    });

    it('wraps execution in the trace context when one is provided', async () => {
      const traceContext = { traceName: 'manual-run', tags: [], metadata: {} };

      await runSession({ traceContext });

      expect(wrapWithTraceContext).toHaveBeenCalledWith(
        traceContext,
        expect.any(Function),
      );
      expect(session.prompt).toHaveBeenCalled();
    });

    it('does not wrap execution without a trace context', async () => {
      await runSession();

      expect(wrapWithTraceContext).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('fails the run when the final assistant message stopped with an error', async () => {
      session = createFakeSession([
        assistantError('overloaded'),
        toolResult('tc-1', 'ignored'),
      ]);

      await expect(runSession()).rejects.toThrow(
        'Agent run failed: overloaded',
      );
      expect(globalHandler.onComplete).toHaveBeenCalled();
      expect(factory.close).toHaveBeenCalledWith(session);
    });

    it('succeeds when a later assistant message recovers from an error', async () => {
      session = createFakeSession([
        assistantError('overloaded'),
        assistantToolCall('bash', { command: 'ls' }),
        assistantText('Done'),
      ]);

      await expect(runSession()).resolves.toEqual({
        sessionId: 'pi-session-1',
      });
    });

    it('propagates a prompt error and still completes, untracks and closes', async () => {
      session.prompt.mockRejectedValue(new Error('boom'));
      const untrack = jest.spyOn(tracker, 'untrack');

      await expect(runSession({ runId: 'run-1' })).rejects.toThrow('boom');

      expect(session.waitForIdle).not.toHaveBeenCalled();
      expect(globalHandler.onComplete).toHaveBeenCalled();
      expect(untrack).toHaveBeenCalledWith('run-1', 'run-1');
      expect(factory.close).toHaveBeenCalledWith(session);
    });

    it('closes the session after a successful run', async () => {
      await runSession();

      expect(factory.close).toHaveBeenCalledWith(session);
    });
  });

  describe('abort', () => {
    it('aborts the session when the run controller fires', async () => {
      promptUntilAborted(session);
      const abortController = new AbortController();

      const run = runSession({ abortController });
      await new Promise((resolve) => setImmediate(resolve));
      abortController.abort();

      await expect(run).rejects.toThrow('Agent run aborted');
      expect(session.abort).toHaveBeenCalledTimes(1);
      expect(globalHandler.onComplete).toHaveBeenCalled();
      expect(factory.close).toHaveBeenCalledWith(session);
    });

    it('aborts the session via abortByRunId', async () => {
      promptUntilAborted(session);

      const run = runSession({ runId: 'run-1' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.abortByRunId('run-1')).toBe(true);
      await expect(run).rejects.toThrow('Agent run aborted');
      expect(session.abort).toHaveBeenCalledTimes(1);
    });

    it('aborts the session via abortSession with the external session id', async () => {
      promptUntilAborted(session);

      const run = runSession({ externalSessionId: 'linear-1', runId: 'run-1' });
      await new Promise((resolve) => setImmediate(resolve));

      expect(service.abortSession('linear-1')).toBe(true);
      await expect(run).rejects.toThrow('Agent run aborted');
    });

    it('catches a rejecting session.abort() and still ends the run as aborted', async () => {
      const loggerError = jest.spyOn(Logger.prototype, 'error');
      promptUntilAborted(session, () =>
        Promise.reject(new Error('abort failed')),
      );
      const abortController = new AbortController();

      const run = runSession({ abortController });
      await new Promise((resolve) => setImmediate(resolve));
      abortController.abort();

      // Jest fails the test on an unhandled rejection, so passing here also
      // proves the abort() rejection was caught.
      await expect(run).rejects.toThrow('Agent run aborted');
      expect(loggerError).toHaveBeenCalledWith('Failed to abort pi session', {
        error: new Error('abort failed'),
      });
      expect(factory.close).toHaveBeenCalledWith(session);
    });

    it('skips the prompt when aborted before session creation completes', async () => {
      let finishCreate: () => void = () => undefined;
      factory.create.mockReturnValue(
        new Promise((resolve) => (finishCreate = () => resolve(session))),
      );
      const untrack = jest.spyOn(tracker, 'untrack');
      const abortController = new AbortController();

      const run = runSession({ abortController, runId: 'run-1' });
      abortController.abort();
      finishCreate();

      await expect(run).rejects.toThrow('Agent run aborted');
      expect(session.prompt).not.toHaveBeenCalled();
      expect(session.abort).not.toHaveBeenCalled();
      expect(globalHandler.onStart).not.toHaveBeenCalled();
      expect(untrack).toHaveBeenCalledWith('run-1', 'run-1');
      expect(factory.close).toHaveBeenCalledWith(session);
    });

    it('stops listening for aborts once the run has finished', async () => {
      const abortController = new AbortController();

      await runSession({ abortController });
      abortController.abort();

      expect(session.abort).not.toHaveBeenCalled();
    });
  });

  describe('session tracking', () => {
    it('tracks by externalSessionId and runId, then untracks both', async () => {
      const track = jest.spyOn(tracker, 'track');
      const untrack = jest.spyOn(tracker, 'untrack');

      await runSession({ externalSessionId: 'linear-1', runId: 'run-1' });

      expect(track).toHaveBeenCalledWith(
        'linear-1',
        expect.any(AbortController),
        'run-1',
      );
      expect(untrack).toHaveBeenCalledWith('linear-1', 'run-1');
      expect(service.abortByRunId('run-1')).toBe(false);
    });

    it('tracks by runId alone when there is no externalSessionId', async () => {
      const track = jest.spyOn(tracker, 'track');

      await runSession({ runId: 'run-1' });

      expect(track).toHaveBeenCalledWith(
        'run-1',
        expect.any(AbortController),
        'run-1',
      );
    });

    it('does not track without an externalSessionId or runId', async () => {
      const track = jest.spyOn(tracker, 'track');
      const untrack = jest.spyOn(tracker, 'untrack');

      await runSession();

      expect(track).not.toHaveBeenCalled();
      expect(untrack).not.toHaveBeenCalled();
    });
  });
});
