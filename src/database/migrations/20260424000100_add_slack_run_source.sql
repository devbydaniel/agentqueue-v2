-- migrate:up
ALTER TYPE "run_source" ADD VALUE IF NOT EXISTS 'slack';

-- migrate:down
-- ENUM values cannot be safely removed in PostgreSQL; 'slack' stays on rollback.
