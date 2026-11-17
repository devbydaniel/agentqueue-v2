import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PgBoss } from 'pg-boss';
import {
  closeTestDb,
  getTestDb,
  truncateAll,
} from '../../test/integration/db.js';
import type { AppConfigService } from '../config/app-config.service.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { QueueConfig } from '../config/trigger-config.interface.js';
import type { ActiveSessionTrackerService } from './active-session-tracker.service.js';
import type { RunEventRepository } from './run-event.repository.js';
import type { RunProcessorService } from './run-processor.service.js';
import { RunQueueWorkerService } from './run-queue-worker.service.js';
import { RunRepository } from './run.repository.js';
import { RunsService } from './runs.service.js';

/**
 * Real pg-boss workers against the test database. The processor is a fake
 * that marks the run running and then blocks until the test releases it, so
 * the tests can see which runs work at the same time.
 */
class BlockingProcessor {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  private readonly releases = new Map<string, () => void>();

  constructor(private readonly runRepository: RunRepository) {}

  async processRun(runId: string): Promise<void> {
    const run = await this.runRepository.findById(runId);
    run!.status = 'running';
    await this.runRepository.save(run!);
    await new Promise<void>((resolve) => {
      this.releases.set(runId, resolve);
      this.started.push(runId);
    });
    this.finished.push(runId);
  }

  release(runId: string): boolean {
    const release = this.releases.get(runId);
    this.releases.delete(runId);
    release?.();
    return Boolean(release);
  }

  abortByRunId(runId: string): boolean {
    return this.release(runId);
  }

  releaseAll(): void {
    for (const runId of [...this.releases.keys()]) this.release(runId);
  }
}

async function waitFor(
  condition: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Run queues (integration)', () => {
  let boss: PgBoss;
  let runRepository: RunRepository;
  let processor: BlockingProcessor;
  let runsService: RunsService;
  let cwd: string;

  async function startWorkers(queues: QueueConfig[]): Promise<void> {
    const worker = new RunQueueWorkerService(
      boss,
      { queueConcurrency: 1 } as AppConfigService,
      { getQueues: () => queues } as unknown as TriggerConfigService,
      processor as unknown as RunProcessorService,
      { abortAll: () => 0 } as unknown as ActiveSessionTrackerService,
    );
    await worker.onModuleInit();
  }

  const enqueue = (queue?: string) =>
    runsService
      .enqueue({ source: 'github', cwd, prompt: 'work', queue })
      .then(({ runId }) => runId);

  beforeEach(async () => {
    await truncateAll();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-queues-'));
    boss = new PgBoss({ connectionString: process.env.TEST_DATABASE_URL });
    boss.on('error', () => undefined);
    await boss.start();
    runRepository = new RunRepository(getTestDb());
    processor = new BlockingProcessor(runRepository);
    runsService = new RunsService(
      processor as unknown as RunProcessorService,
      runRepository,
      {} as RunEventRepository,
      boss,
      { runTimeoutMs: 60_000 } as AppConfigService,
    );
  });

  afterEach(async () => {
    processor.releaseAll();
    await boss.stop({ graceful: true, timeout: 5_000 });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('runs triggers in different queues at the same time', async () => {
    await startWorkers([
      { name: 'q_one', concurrency: 1 },
      { name: 'q_two', concurrency: 1 },
    ]);

    const first = await enqueue('q_one');
    const second = await enqueue('q_two');

    await waitFor(() => processor.started.length === 2);
    expect(processor.started).toEqual(expect.arrayContaining([first, second]));
    expect(processor.finished).toEqual([]);
    expect((await runRepository.findById(first))!.queue).toBe('q_one');
    expect((await runRepository.findById(second))!.queue).toBe('q_two');
  });

  it('runs triggers in the same queue one after the other', async () => {
    await startWorkers([{ name: 'q_same', concurrency: 1 }]);

    const first = await enqueue('q_same');
    await waitFor(() => processor.started.length === 1);
    const second = await enqueue('q_same');

    // Longer than pg-boss's 2 s polling interval: the second run stays queued.
    await sleep(4_000);
    expect(processor.started).toEqual([first]);

    processor.release(first);
    await waitFor(() => processor.started.length === 2);
    expect(processor.started).toEqual([first, second]);
    expect(processor.finished).toEqual([first]);
  });

  it('keeps a custom queue free while the default queue is full', async () => {
    await startWorkers([{ name: 'q_gate', concurrency: 1 }]);

    const busy = await enqueue();
    await waitFor(() => processor.started.length === 1);
    const queued = await enqueue();
    const gate = await enqueue('q_gate');

    await waitFor(() => processor.started.length === 2);
    expect(processor.started).toEqual([busy, gate]);
    expect((await runRepository.findById(queued))!.status).toBe('waiting');
    expect((await runRepository.findById(busy))!.queue).toBe('runs');
  });

  it('cancels the job of a waiting run in a custom queue on abort', async () => {
    await startWorkers([{ name: 'q_abort', concurrency: 1 }]);

    const running = await enqueue('q_abort');
    await waitFor(() => processor.started.length === 1);
    const waiting = await enqueue('q_abort');

    expect(await runsService.abortRun(waiting)).toEqual({ aborted: true });

    const run = await runRepository.findById(waiting);
    expect(run!.status).toBe('aborted');
    const [job] = await boss.findJobs('q_abort', { id: run!.queueJobId! });
    expect(job.state).toBe('cancelled');

    processor.release(running);
    await sleep(4_000);
    expect(processor.started).toEqual([running]);
  });

  it('stops a running run in a custom queue on abort', async () => {
    await startWorkers([{ name: 'q_stop', concurrency: 1 }]);

    const running = await enqueue('q_stop');
    await waitFor(() => processor.started.length === 1);

    expect(await runsService.abortRun(running)).toEqual({ aborted: true });

    await waitFor(() => processor.finished.length === 1);
    expect((await runRepository.findById(running))!.status).toBe('aborted');
  });
});
