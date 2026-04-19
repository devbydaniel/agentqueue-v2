-- migrate:up
ALTER TABLE "runs" RENAME COLUMN "parent_flow_run_id" TO "parent_run_id";
ALTER TYPE "run_source" ADD VALUE IF NOT EXISTS 'spawned';

-- migrate:down
ALTER TABLE "runs" RENAME COLUMN "parent_run_id" TO "parent_flow_run_id";
-- ENUM values cannot be safely removed in PostgreSQL; 'spawned' stays on rollback.
