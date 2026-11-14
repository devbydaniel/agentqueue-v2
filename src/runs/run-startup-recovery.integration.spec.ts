/* eslint-disable sonarjs/publicly-writable-directories */
import { getTestDb, truncateAll } from '../../test/integration/db.js';
import { RunRepository } from './run.repository.js';
import { RunStartupRecoveryService } from './run-startup-recovery.service.js';
import type { LinearCallbackHandlerFactory } from '../callbacks/handlers/linear.callback-handler.js';

describe('RunStartupRecoveryService (integration)', () => {
  let runRepo: RunRepository;
  let recoveryService: RunStartupRecoveryService;
  const emitError = jest.fn().mockResolvedValue(undefined);
  const createForRun = jest.fn().mockReturnValue({ emitError });

  beforeAll(() => {
    const db = getTestDb();
    runRepo = new RunRepository(db);
    recoveryService = new RunStartupRecoveryService(runRepo, {
      createForRun,
    } as unknown as LinearCallbackHandlerFactory);
  });

  beforeEach(async () => {
    await truncateAll();
    jest.clearAllMocks();
  });

  it('should mark running run rows as interrupted on init', async () => {
    const runningRun = await runRepo.create({
      source: 'manual',
      cwd: '/tmp/test-repo',
      prompt: 'abandoned run',
    });
    runningRun.status = 'running';
    runningRun.startedAt = new Date();
    runningRun.attemptsMade = 1;
    await runRepo.save(runningRun);

    const waitingRun = await runRepo.create({
      source: 'cron',
      cwd: '/tmp/test-repo',
      prompt: 'waiting run',
    });

    await recoveryService.onModuleInit();

    const recovered = await runRepo.findById(runningRun.id);
    expect(recovered!.status).toBe('interrupted');
    expect(recovered!.errorMessage).toBe(
      'Process restarted while run was in progress',
    );
    expect(recovered!.completedAt).toBeInstanceOf(Date);

    const stillWaiting = await runRepo.findById(waitingRun.id);
    expect(stillWaiting!.status).toBe('waiting');
  });

  it('should not touch already-terminal runs', async () => {
    const succeededRun = await runRepo.create({
      source: 'manual',
      cwd: '/tmp/test-repo',
      prompt: 'completed run',
    });
    succeededRun.status = 'succeeded';
    succeededRun.completedAt = new Date();
    await runRepo.save(succeededRun);

    await recoveryService.onModuleInit();

    const unchanged = await runRepo.findById(succeededRun.id);
    expect(unchanged!.status).toBe('succeeded');
  });

  it('should report an interrupted Linear run to its agent session', async () => {
    const linearRun = await runRepo.create({
      source: 'linear',
      triggerName: 'ayc-dev:assigned',
      externalSessionId: 'agent-session-1',
      cwd: '/tmp/test-repo',
      prompt: 'abandoned linear run',
    });
    linearRun.status = 'running';
    await runRepo.save(linearRun);

    await recoveryService.onModuleInit();
    recoveryService.onApplicationBootstrap();

    expect(createForRun).toHaveBeenCalledWith(
      'ayc-dev:assigned',
      'agent-session-1',
    );
    expect(emitError).toHaveBeenCalledWith(
      'Process restarted while run was in progress',
    );
  });

  it('should handle no abandoned runs gracefully', async () => {
    await recoveryService.onModuleInit();
  });
});
