-- migrate:up
ALTER TABLE "runs" DROP COLUMN "agent_name";

-- migrate:down
ALTER TABLE "runs" ADD COLUMN "agent_name" varchar(255);
