import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  boolean,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { flowRuns } from './flow-runs.schema.js';
import { runs } from './runs.schema.js';

export const flowSteps = pgTable(
  'flow_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowRunId: uuid('flow_run_id')
      .notNull()
      .references(() => flowRuns.flowRunId, { onDelete: 'cascade' }),
    /** Ordering index within the flow run (0-based). */
    stepIndex: integer('step_index').notNull(),
    agent: varchar('agent', { length: 255 }).notNull(),
    vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    success: boolean('success'),
    /** Links to the underlying agent run row (nullable — old steps won't have it). */
    runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
  },
  (table) => [index('flow_steps_flow_run_id_idx').on(table.flowRunId)],
);

export type FlowStepRow = typeof flowSteps.$inferSelect;
export type NewFlowStepRow = typeof flowSteps.$inferInsert;
