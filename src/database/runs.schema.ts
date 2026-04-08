import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const runSourceEnum = pgEnum('run_source', [
  'manual',
  'cron',
  'linear',
  'github',
  'flow',
]);

export const runStatusEnum = pgEnum('run_status', [
  'waiting',
  'running',
  'succeeded',
  'errored',
  'aborted',
  'timed_out',
  'interrupted',
]);

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  source: runSourceEnum('source').notNull(),
  triggerName: varchar('trigger_name', { length: 255 }),
  parentFlowRunId: uuid('parent_flow_run_id'),
  repo: varchar('repo', { length: 255 }).notNull(),
  prompt: text('prompt').notNull(),
  promptPreview: varchar('prompt_preview', { length: 500 }),
  status: runStatusEnum('status').notNull().default('waiting'),
  attemptsMade: integer('attempts_made').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  errorMessage: text('error_message'),
  sessionKey: varchar('session_key', { length: 255 }),
  prependSystemPrompt: text('prepend_system_prompt'),
  appendSystemPrompt: text('append_system_prompt'),
  timeoutMs: integer('timeout_ms'),
  queueJobId: varchar('queue_job_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
