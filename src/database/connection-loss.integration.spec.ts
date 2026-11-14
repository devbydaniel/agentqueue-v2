import type pg from 'pg';
import type { PgBoss } from 'pg-boss';
import type { AppConfigService } from '../config/app-config.service.js';
import { bossProvider } from '../queue/queue.providers.js';
import { databaseProviders } from './database.providers.js';
import { getTestDb } from '../../test/integration/db.js';

type Factory<T> = { useFactory: (config: AppConfigService) => T };

const config = {
  databaseUrl: process.env.TEST_DATABASE_URL,
} as AppConfigService;

async function terminateBackends(applicationName: string): Promise<number> {
  const result = await getTestDb().query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
     WHERE application_name = $1 AND pid <> pg_backend_pid()`,
    [applicationName],
  );
  return result.rowCount ?? 0;
}

// An error the driver emits after the connection drops reaches no caller, only
// the emitter. Without a listener Node throws it and the whole process exits,
// taking every run in flight with it.
describe('database connection loss (integration)', () => {
  it('keeps the process alive when pg-boss loses its connections', async () => {
    const boss = (bossProvider as Factory<PgBoss>).useFactory(config);
    await boss.start();

    try {
      expect(await terminateBackends('pgboss')).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(boss.getQueues()).resolves.toBeDefined();
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it('keeps the process alive when the app pool loses an idle connection', async () => {
    const pool = (databaseProviders[0] as Factory<pg.Pool>).useFactory(config);
    await pool.query(`SET application_name = 'agentqueue-pool-test'`);

    try {
      expect(await terminateBackends('agentqueue-pool-test')).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 500));

      await expect(pool.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      await pool.end();
    }
  });
});
