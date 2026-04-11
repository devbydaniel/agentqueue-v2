export const runSources = [
  'manual',
  'cron',
  'linear',
  'github',
  'flow',
  'telegram',
] as const;

export const runStatuses = [
  'waiting',
  'running',
  'succeeded',
  'errored',
  'aborted',
  'timed_out',
  'interrupted',
] as const;

export interface Run {
  id: string;
  source: (typeof runSources)[number];
  triggerName: string | null;
  parentFlowRunId: string | null;
  cwd: string;
  prompt: string;
  promptPreview: string | null;
  status: (typeof runStatuses)[number];
  attemptsMade: number;
  startedAt: Date | null;
  completedAt: Date | null;
  errorMessage: string | null;
  externalSessionId: string | null;
  appendSystemPrompt: string | null;
  timeoutMs: number | null;
  queueJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewRun {
  source: Run['source'];
  triggerName?: string | null;
  parentFlowRunId?: string | null;
  cwd: string;
  prompt: string;
  promptPreview?: string | null;
  status?: Run['status'];
  attemptsMade?: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
  errorMessage?: string | null;
  externalSessionId?: string | null;
  appendSystemPrompt?: string | null;
  timeoutMs?: number | null;
  queueJobId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}
