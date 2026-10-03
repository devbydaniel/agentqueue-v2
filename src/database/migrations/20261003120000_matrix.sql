-- migrate:up
ALTER TYPE "run_source" ADD VALUE IF NOT EXISTS 'matrix';

-- One row per Matrix bot: the /sync `next_batch` token, so a restart resumes
-- where it left off instead of replaying the room timeline as new messages.
CREATE TABLE "matrix_sync_state" (
  "bot_name" varchar(255) PRIMARY KEY NOT NULL,
  "next_batch" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS "matrix_sync_state";
-- ENUM values cannot be safely removed in PostgreSQL; 'matrix' stays on rollback.
