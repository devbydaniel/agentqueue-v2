-- migrate:up
-- The pg-boss queue a run was sent to, so abort cancels its job there.
-- Existing runs were all sent to the default queue.
ALTER TABLE "runs" ADD COLUMN "queue" varchar(255) DEFAULT 'runs' NOT NULL;

-- migrate:down
ALTER TABLE "runs" DROP COLUMN "queue";
