import { getTestDb, truncateAll } from '../../test/integration/db.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowRunStartupRecoveryService } from './flow-run-startup-recovery.service.js';

describe('FlowRunStartupRecoveryService (integration)', () => {
  let flowRunRepo: FlowRunRepository;
  let recoveryService: FlowRunStartupRecoveryService;

  beforeAll(() => {
    const db = getTestDb();
    flowRunRepo = new FlowRunRepository(db);
    recoveryService = new FlowRunStartupRecoveryService(flowRunRepo);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('should mark running flow run rows as interrupted on init', async () => {
    const runningFlow = await flowRunRepo.create('factory', { task: 'build' });
    const doneFlow = await flowRunRepo.create('bugfix', {});
    doneFlow.status = 'done';
    doneFlow.completedAt = new Date();
    await flowRunRepo.save(doneFlow);

    await recoveryService.onModuleInit();

    const recovered = await flowRunRepo.findById(runningFlow.flowRunId);
    expect(recovered!.status).toBe('interrupted');
    expect(recovered!.message).toBe(
      'Process restarted while flow was in progress',
    );
    expect(recovered!.completedAt).toBeInstanceOf(Date);

    const stillDone = await flowRunRepo.findById(doneFlow.flowRunId);
    expect(stillDone!.status).toBe('done');
  });

  it('should handle no abandoned flow runs gracefully', async () => {
    await recoveryService.onModuleInit();
  });
});
