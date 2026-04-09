export interface RunEvent {
  id: string;
  runId: string;
  type: string;
  payload: unknown;
  createdAt: Date;
}

export interface NewRunEvent {
  runId: string;
  type: string;
  payload?: unknown;
  createdAt?: Date;
}
