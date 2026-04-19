import {
  buildSessionId,
  buildTraceContext,
  type TraceableRun,
} from './build-trace-context.js';

function makeRun(overrides: Partial<TraceableRun> = {}): TraceableRun {
  return {
    id: 'run-123',
    source: 'manual',
    triggerName: null,
    parentRunId: null,
    cwd: '/home/user/dev/my-repo',
    externalSessionId: null,
    ...overrides,
  };
}

describe('buildSessionId', () => {
  it('should return externalSessionId for linear runs', () => {
    expect(
      buildSessionId(
        makeRun({ source: 'linear', externalSessionId: 'linear-session-1' }),
      ),
    ).toBe('linear-session-1');
  });

  it('should return externalSessionId for telegram runs', () => {
    expect(
      buildSessionId(
        makeRun({
          source: 'telegram',
          externalSessionId: 'telegram:bot:123:main',
        }),
      ),
    ).toBe('telegram:bot:123:main');
  });

  it('should return parentRunId for flow child runs', () => {
    expect(
      buildSessionId(makeRun({ source: 'flow', parentRunId: 'flow-99' })),
    ).toBe('flow-99');
  });

  it('should return parentRunId for non-flow spawned runs', () => {
    expect(
      buildSessionId(makeRun({ source: 'spawned', parentRunId: 'parent-42' })),
    ).toBe('parent-42');
  });

  it('should return undefined for manual runs', () => {
    expect(buildSessionId(makeRun())).toBeUndefined();
  });

  it('should return undefined for linear runs without externalSessionId', () => {
    expect(buildSessionId(makeRun({ source: 'linear' }))).toBeUndefined();
  });
});

describe('buildTraceContext', () => {
  it('should build context for linear runs with shared session', () => {
    const context = buildTraceContext(
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

  it('should group flow child runs by parentRunId', () => {
    const context = buildTraceContext(
      makeRun({ source: 'flow', parentRunId: 'flow-run-99' }),
    );

    expect(context).toEqual({
      traceName: 'flow-run',
      tags: ['source:flow', 'flow:child', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'flow',
        repoName: 'my-repo',
        parentRunId: 'flow-run-99',
      },
      sessionId: 'flow-run-99',
    });
  });

  it('should tag non-flow spawned runs as spawned and group by parentRunId', () => {
    const context = buildTraceContext(
      makeRun({ source: 'spawned', parentRunId: 'parent-42' }),
    );

    expect(context).toEqual({
      traceName: 'spawned-run',
      tags: ['source:spawned', 'spawned', 'session:shared'],
      metadata: {
        runId: 'run-123',
        source: 'spawned',
        repoName: 'my-repo',
        parentRunId: 'parent-42',
      },
      sessionId: 'parent-42',
    });
  });

  it('should mark manual runs as ephemeral sessions', () => {
    const context = buildTraceContext(makeRun());

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
});
