import { basename } from 'node:path';

export interface TraceContext {
  traceName: string;
  tags: string[];
  metadata: Record<string, string>;
  sessionId?: string;
}

export interface TraceableRun {
  id: string;
  source: string;
  triggerName: string | null;
  parentRunId: string | null;
  cwd: string;
  externalSessionId: string | null;
}

export function buildSessionId(run: TraceableRun): string | undefined {
  if (
    (run.source === 'linear' || run.source === 'telegram') &&
    run.externalSessionId
  ) {
    return run.externalSessionId;
  }

  if (run.parentRunId) {
    return run.parentRunId;
  }

  return undefined;
}

export function buildTraceContext(run: TraceableRun): TraceContext {
  const sessionId = buildSessionId(run);
  const tags = [`source:${run.source}`];

  if (run.triggerName) {
    tags.push(`trigger:${run.triggerName}`);
  }

  if (run.parentRunId) {
    tags.push(run.source === 'flow' ? 'flow:child' : 'spawned');
  }

  tags.push(sessionId ? 'session:shared' : 'session:ephemeral');

  const metadata: Record<string, string> = {
    runId: run.id,
    source: run.source,
    repoName: basename(run.cwd),
  };

  if (run.triggerName) {
    metadata['triggerName'] = run.triggerName;
  }

  if (run.externalSessionId) {
    metadata['externalSessionId'] = run.externalSessionId;
  }

  if (run.parentRunId) {
    metadata['parentRunId'] = run.parentRunId;
  }

  return {
    traceName: `${run.source}-run`,
    tags,
    metadata,
    sessionId,
  };
}
