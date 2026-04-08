import { getTestDb, truncateAll } from '../../test/integration/db.js';
import { RunRepository } from './run.repository.js';
import { RunStartupRecoveryService } from './run-startup-recovery.service.js';

describe('RunStartupRecoveryService (integration)', () => {
  let runRepo: RunRepository;
  let recoveryService: RunStartupRecoveryService;

  beforeAll(() => {
    const db = getTestDb();
    runRepo = new RunRepository(db);
    recoveryService = new RunStartupRecoveryService(runRepo);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('should mark running rows as interrupted on init', async () => {
    // Create two runs: one running (abandoned), one waiting (should stay)
    const runningRun = await runRepo.create({
      source: 'manual',
      repo: 'test-repo',
      prompt: 'abandoned run',
    });
    runningRun.status = 'running';
    runningRun.startedAt = new Date();
    runningRun.attemptsMade = 1;
    await runRepo.save(runningRun);

    const waitingRun = await runRepo.create({
      source: 'cron',
      repo: 'test-repo',
      prompt: 'waiting run',
    });

    // Run recovery
    await recoveryService.onModuleInit();

    // Running run should now be interrupted
    const recovered = await runRepo.findById(runningRun.id);
    expect(recovered!.status).toBe('interrupted');
    expect(recovered!.errorMessage).toBe(
      'Process restarted while run was in progress',
    );
    expect(recovered!.completedAt).toBeInstanceOf(Date);

    // Waiting run should be unchanged
    const stillWaiting = await runRepo.findById(waitingRun.id);
    expect(stillWaiting!.status).toBe('waiting');
  });

  it('should not touch already-terminal runs', async () => {
    const succeededRun = await runRepo.create({
      source: 'manual',
      repo: 'test-repo',
      prompt: 'completed run',
    });
    succeededRun.status = 'succeeded';
    succeededRun.completedAt = new Date();
    await runRepo.save(succeededRun);

    await recoveryService.onModuleInit();

    const unchanged = await runRepo.findById(succeededRun.id);
    expect(unchanged!.status).toBe('succeeded');
  });

  it('should handle no abandoned runs gracefully', async () => {
    // Empty database — should not throw
    await recoveryService.onModuleInit();
  });
});
