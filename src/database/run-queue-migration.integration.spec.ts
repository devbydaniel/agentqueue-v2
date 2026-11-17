import pg from 'pg';
import { applyMigrations } from '../../test/integration/migrate.js';
import { RunRepository } from '../runs/run.repository.js';

const QUEUE_MIGRATION = '20261117120000_run_queue.sql';

/**
 * Runs the migrations into a scratch schema in two steps — everything before
 * the queue migration, a run written then, the queue migration — and reads
 * the old run back.
 */
describe('run queue migration (integration)', () => {
  const schema = 'run_queue_migration';
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    const connectionString = process.env.TEST_DATABASE_URL;
    admin = new pg.Pool({ connectionString });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({
      connectionString,
      options: `-c search_path=${schema},public`,
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it('keeps existing runs readable and counts them as queue "runs"', async () => {
    await applyMigrations(pool, (file) => file < QUEUE_MIGRATION);
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO runs (source, cwd, prompt, status, queue_job_id)
       VALUES ('linear', '/srv/repo', 'old run', 'waiting', 'job-1')
       RETURNING id`,
    );

    await applyMigrations(pool, (file) => file === QUEUE_MIGRATION);

    const run = await new RunRepository(pool).findById(inserted.rows[0].id);
    expect(run).toMatchObject({
      source: 'linear',
      prompt: 'old run',
      status: 'waiting',
      queueJobId: 'job-1',
      queue: 'runs',
    });
  });
});
