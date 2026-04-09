import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import pg from 'pg';
import { applyMigrations } from './migrate';

let container: StartedPostgreSqlContainer;

export default async function globalSetup() {
  // Colima / non-default Docker socket support
  if (!process.env.DOCKER_HOST) {
    const colimaSocket = `${process.env.HOME}/.colima/default/docker.sock`;
    try {
      const fs = await import('node:fs');
      if (fs.existsSync(colimaSocket)) {
        process.env.DOCKER_HOST = `unix://${colimaSocket}`;
        // Tell testcontainers to mount /var/run/docker.sock inside the VM
        // rather than the host-side Colima socket path
        process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE =
          '/var/run/docker.sock';
      }
    } catch {
      // ignore
    }
  }
  container = await new PostgreSqlContainer('postgres:16')
    .withDatabase('agentqueue_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();

  // Run SQL migrations
  const pool = new pg.Pool({ connectionString });
  await applyMigrations(pool);
  await pool.end();

  // Expose to test environment
  process.env.TEST_DATABASE_URL = connectionString;

  // Store the container so teardown can stop it
  (globalThis as Record<string, unknown>).__POSTGRES_CONTAINER__ = container;
}
