-- migrate:up
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE "run_source" AS ENUM (
  'manual',
  'cron',
  'linear',
  'github',
  'flow',
  'telegram'
);

CREATE TYPE "run_status" AS ENUM (
  'waiting',
  'running',
  'succeeded',
  'errored',
  'aborted',
  'timed_out',
  'interrupted'
);

CREATE TYPE "flow_run_status" AS ENUM (
  'running',
  'done',
  'escalated',
  'errored',
  'aborted',
  'interrupted'
);

CREATE TABLE "runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" "run_source" NOT NULL,
  "trigger_name" varchar(255),
  "parent_flow_run_id" uuid,
  "cwd" varchar(1024) NOT NULL,
  "prompt" text NOT NULL,
  "prompt_preview" varchar(500),
  "status" "run_status" DEFAULT 'waiting' NOT NULL,
  "attempts_made" integer DEFAULT 0 NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error_message" text,
  "external_session_id" varchar(255),
  "prepend_system_prompt" text,
  "append_system_prompt" text,
  "timeout_ms" integer,
  "queue_job_id" varchar(255),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "run_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "type" varchar(100) NOT NULL,
  "payload" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "run_events_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE cascade
);

CREATE INDEX "run_events_run_id_created_at_idx"
  ON "run_events" ("run_id", "created_at");

CREATE TABLE "flow_runs" (
  "flow_run_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "flow_name" varchar(255) NOT NULL,
  "status" "flow_run_status" DEFAULT 'running' NOT NULL,
  "vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "current_agent" varchar(255),
  "message" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);

CREATE TABLE "flow_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "flow_run_id" uuid NOT NULL,
  "step_index" integer NOT NULL,
  "agent" varchar(255) NOT NULL,
  "vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "success" boolean,
  "run_id" uuid,
  CONSTRAINT "flow_steps_flow_run_id_flow_runs_flow_run_id_fk"
    FOREIGN KEY ("flow_run_id") REFERENCES "flow_runs"("flow_run_id") ON DELETE cascade,
  CONSTRAINT "flow_steps_run_id_runs_id_fk"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE set null
);

CREATE INDEX "flow_steps_flow_run_id_idx"
  ON "flow_steps" ("flow_run_id");

CREATE TABLE "external_sessions" (
  "provider" varchar(50) NOT NULL,
  "session_key" varchar(255) PRIMARY KEY NOT NULL,
  "file_path" varchar(1024),
  "bot_name" varchar(255),
  "chat_id" varchar(255),
  "message_thread_id" integer,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS "external_sessions";
DROP TABLE IF EXISTS "flow_steps";
DROP TABLE IF EXISTS "flow_runs";
DROP TABLE IF EXISTS "run_events";
DROP TABLE IF EXISTS "runs";
DROP TYPE IF EXISTS "flow_run_status";
DROP TYPE IF EXISTS "run_status";
DROP TYPE IF EXISTS "run_source";
