import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  pgEnum,
} from 'drizzle-orm/pg-core';

export const flowRunStatusEnum = pgEnum('flow_run_status', [
  'running',
  'done',
  'escalated',
  'errored',
  'aborted',
  'interrupted',
]);

export const flowRuns = pgTable('flow_runs', {
  flowRunId: uuid('flow_run_id').primaryKey().defaultRandom(),
  flowName: varchar('flow_name', { length: 255 }).notNull(),
  status: flowRunStatusEnum('status').notNull().default('running'),
  vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
  currentAgent: varchar('current_agent', { length: 255 }),
  message: text('message'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export type FlowRunRow = typeof flowRuns.$inferSelect;
export type NewFlowRunRow = typeof flowRuns.$inferInsert;
