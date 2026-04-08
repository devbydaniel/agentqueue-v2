CREATE TYPE "public"."run_source" AS ENUM('manual', 'cron', 'linear', 'github', 'flow');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('waiting', 'running', 'succeeded', 'errored', 'aborted', 'timed_out', 'interrupted');--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "run_source" NOT NULL,
	"trigger_name" varchar(255),
	"parent_flow_run_id" uuid,
	"repo" varchar(255) NOT NULL,
	"prompt" text NOT NULL,
	"prompt_preview" varchar(500),
	"status" "run_status" DEFAULT 'waiting' NOT NULL,
	"attempts_made" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"session_key" varchar(255),
	"prepend_system_prompt" text,
	"append_system_prompt" text,
	"queue_job_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
