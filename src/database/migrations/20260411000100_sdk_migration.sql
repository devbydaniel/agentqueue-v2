-- migrate:up
ALTER TABLE "runs" ADD COLUMN "agent_name" varchar(255);
ALTER TABLE "runs" DROP COLUMN "prepend_system_prompt";
ALTER TABLE "external_sessions" RENAME COLUMN "file_path" TO "session_id";

-- migrate:down
ALTER TABLE "external_sessions" RENAME COLUMN "session_id" TO "file_path";
ALTER TABLE "runs" ADD COLUMN "prepend_system_prompt" text;
ALTER TABLE "runs" DROP COLUMN "agent_name";
