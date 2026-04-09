/* eslint-disable sonarjs/publicly-writable-directories */
import { getTestDb, truncateAll } from '../../test/integration/db.js';
import { RunRepository } from './run.repository.js';

/**
 * Integration test for the enqueue → process lifecycle.
 *
 * We don't import pg-boss directly (it's ESM-only and doesn't transform under
 * ts-jest/CJS). Instead, we exercise the run repository + direct SQL to
 * simulate the full lifecycle: create run → mark waiting → mark running →
 * mark terminal status. This validates the database layer that processRun()
 * and enqueue() rely on.
 *
 * The actual pg-boss handler wiring is covered by unit tests with mocked Boss.
 */
describe('RunProcessor lifecycle (integration)', () => {
  let runRepo: RunRepository;

  beforeAll(() => {
    const db = getTestDb();
    runRepo = new RunRepository(db);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('should support the full enqueue → running → succeeded lifecycle', async () => {
    // 1. Create a run (simulates enqueue)
    const run = await runRepo.create({
      source: 'manual',
      cwd: '/tmp/test-repo',
      prompt: 'hello world',
    });
    expect(run.status).toBe('waiting');

    // 2. Mark queue job id (simulates boss.send + markWaitingQueueJob)
    await runRepo.markWaitingQueueJob(run.id, 'fake-job-id');
    const afterEnqueue = await runRepo.findById(run.id);
    expect(afterEnqueue!.queueJobId).toBe('fake-job-id');

    // 3. Simulate processRun: mark running
    run.status = 'running';
    run.startedAt = new Date();
    run.attemptsMade = 1;
    await runRepo.save(run);

    const runningRun = await runRepo.findById(run.id);
    expect(runningRun!.status).toBe('running');
    expect(runningRun!.startedAt).toBeInstanceOf(Date);
    expect(runningRun!.attemptsMade).toBe(1);

    // 4. Simulate success: mark succeeded
    run.status = 'succeeded';
    run.completedAt = new Date();
    await runRepo.save(run);

    const finalRun = await runRepo.findById(run.id);
    expect(finalRun!.status).toBe('succeeded');
    expect(finalRun!.completedAt).toBeInstanceOf(Date);
  });

  it('should support the error path: waiting → running → errored', async () => {
    const run = await runRepo.create({
      source: 'cron',
      triggerName: 'daily-check',
      cwd: '/tmp/test-repo',
      prompt: 'run check',
    });

    // Mark running
    run.status = 'running';
    run.startedAt = new Date();
    run.attemptsMade = 1;
    await runRepo.save(run);

    // Mark errored
    run.status = 'errored';
    run.errorMessage = 'session crashed';
    run.completedAt = new Date();
    await runRepo.save(run);

    const finalRun = await runRepo.findById(run.id);
    expect(finalRun!.status).toBe('errored');
    expect(finalRun!.errorMessage).toBe('session crashed');
    expect(finalRun!.completedAt).toBeInstanceOf(Date);
  });

  it('should persist all enqueue fields for a linear-source run', async () => {
    const run = await runRepo.create({
      source: 'linear',
      triggerName: 'my-agent',
      cwd: '/tmp/core',
      prompt: 'fix the bug',
      externalSessionId: 'linear-session-123',
      prependSystemPrompt: 'You are a helpful agent',
      appendSystemPrompt: 'Always run tests',
    });

    const fetched = await runRepo.findById(run.id);
    expect(fetched!.source).toBe('linear');
    expect(fetched!.triggerName).toBe('my-agent');
    expect(fetched!.externalSessionId).toBe('linear-session-123');
    expect(fetched!.prependSystemPrompt).toBe('You are a helpful agent');
    expect(fetched!.appendSystemPrompt).toBe('Always run tests');
  });

  it('should track attemptsMade across multiple processing attempts', async () => {
    const run = await runRepo.create({
      source: 'manual',
      cwd: '/tmp/test-repo',
      prompt: 'retry me',
    });

    // First attempt: running → errored
    run.status = 'running';
    run.attemptsMade = 1;
    run.startedAt = new Date();
    await runRepo.save(run);

    run.status = 'errored';
    run.errorMessage = 'attempt 1 failed';
    run.completedAt = new Date();
    await runRepo.save(run);

    // Simulate retry: reset to running with incremented attempts
    const db = getTestDb();
    await db.query(
      `UPDATE runs
      SET
        status = 'running',
        attempts_made = 2,
        error_message = NULL,
        completed_at = NULL,
        started_at = $2
      WHERE id = $1`,
      [run.id, new Date()],
    );

    // Succeed on second attempt
    await db.query(
      'UPDATE runs SET status = $2, completed_at = $3 WHERE id = $1',
      [run.id, 'succeeded', new Date()],
    );

    const finalRun = await runRepo.findById(run.id);
    expect(finalRun!.status).toBe('succeeded');
    expect(finalRun!.attemptsMade).toBe(2);
  });
});
