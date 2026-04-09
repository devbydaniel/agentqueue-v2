export interface FlowStepRow {
  id: string;
  flowRunId: string;
  stepIndex: number;
  agent: string;
  vars: Record<string, string>;
  startedAt: Date;
  completedAt: Date | null;
  success: boolean | null;
  runId: string | null;
}

export interface NewFlowStepRow {
  id?: string;
  flowRunId: string;
  stepIndex: number;
  agent: string;
  vars: Record<string, string>;
  startedAt: Date;
  completedAt?: Date | null;
  success?: boolean | null;
  runId?: string | null;
}
