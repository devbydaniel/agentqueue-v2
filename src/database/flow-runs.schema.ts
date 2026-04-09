export const flowRunStatuses = [
  'running',
  'done',
  'escalated',
  'errored',
  'aborted',
  'interrupted',
] as const;

export interface FlowRunRow {
  flowRunId: string;
  flowName: string;
  status: (typeof flowRunStatuses)[number];
  vars: Record<string, string>;
  currentAgent: string | null;
  message: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface NewFlowRunRow {
  flowRunId?: string;
  flowName: string;
  status?: FlowRunRow['status'];
  vars: Record<string, string>;
  currentAgent?: string | null;
  message?: string | null;
  startedAt?: Date;
  completedAt?: Date | null;
}
