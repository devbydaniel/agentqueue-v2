import { startObservation } from '@langfuse/tracing';
import {
  LangfuseCallbackHandlerFactory,
  type LangfuseTraceableRun,
} from './langfuse.callback-handler.js';

jest.mock('@langfuse/tracing', () => ({
  startObservation: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    end: jest.fn(),
    startObservation: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      end: jest.fn(),
      startObservation: jest.fn(),
    })),
  })),
}));

describe('LangfuseCallbackHandlerFactory', () => {
  function makeRun(
    overrides: Partial<LangfuseTraceableRun> = {},
  ): LangfuseTraceableRun {
    return {
      id: 'run-123',
      source: 'manual',
      triggerName: null,
      parentFlowRunId: null,
      cwd: '/home/user/dev/my-repo',
      externalSessionId: null,
      ...overrides,
    };
  }

  it('should build source and trigger tags for linear runs with shared session ids', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(
      makeRun({
        source: 'linear',
        triggerName: 'triage-agent',
        externalSessionId: 'linear-session-1',
      }),
    );

    expect(context).toEqual({
      traceName: 'linear-run',
      tags: ['source:linear', 'trigger:triage-agent', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'linear',
        repoName: 'my-repo',
        triggerName: 'triage-agent',
        externalSessionId: 'linear-session-1',
      },
      sessionId: 'linear-session-1',
    });
  });

  it('should group flow child runs by parentFlowRunId', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(
      makeRun({
        source: 'flow',
        parentFlowRunId: 'flow-run-99',
      }),
    );

    expect(context).toEqual({
      traceName: 'flow-run',
      tags: ['source:flow', 'flow:child', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'flow',
        repoName: 'my-repo',
        parentFlowRunId: 'flow-run-99',
      },
      sessionId: 'flow-run-99',
    });
  });

  it('should mark manual runs as ephemeral sessions', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const context = factory.buildTraceContext(makeRun());

    expect(context).toEqual({
      traceName: 'manual-run',
      tags: ['source:manual', 'session:ephemeral'],
      metadata: {
        runId: 'run-123',
        source: 'manual',
        repoName: 'my-repo',
      },
      sessionId: undefined,
    });
  });

  it('should not create Langfuse spans when tracing is disabled', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: false,
    } as never);

    const { handler } = factory.createForRun(makeRun());
    handler.onEvent({ type: 'agent_start' } as never);

    expect(startObservation).not.toHaveBeenCalled();
  });

  it('should start the root span with the per-run trace name and metadata', () => {
    const factory = new LangfuseCallbackHandlerFactory({
      langfuseEnabled: true,
    } as never);

    const { handler } = factory.createForRun(
      makeRun({
        source: 'telegram',
        triggerName: 'daniel-assistant',
        externalSessionId: 'telegram:bot:123:main',
      }),
    );
    handler.onEvent({ type: 'agent_start' } as never);

    expect(startObservation).toHaveBeenCalledWith('telegram-run', {
      input: { event: 'agent_start' },
      metadata: {
        runId: 'run-123',
        source: 'telegram',
        repoName: 'my-repo',
        triggerName: 'daniel-assistant',
        externalSessionId: 'telegram:bot:123:main',
      },
    });
  });
});
