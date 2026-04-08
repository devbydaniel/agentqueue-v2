CREATE TYPE "public"."flow_run_status" AS ENUM('running', 'done', 'escalated', 'errored', 'aborted', 'interrupted');--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE "flow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flow_run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"agent" varchar(255) NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"success" boolean,
	"run_id" uuid
);
--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_flow_run_id_flow_runs_flow_run_id_fk" FOREIGN KEY ("flow_run_id") REFERENCES "public"."flow_runs"("flow_run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_steps" ADD CONSTRAINT "flow_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_steps_flow_run_id_idx" ON "flow_steps" USING btree ("flow_run_id");