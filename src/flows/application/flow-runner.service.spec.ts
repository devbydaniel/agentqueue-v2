import { FlowRunnerService } from './flow-runner.service.js';
import type { Resolver } from './flow-runner.service.js';
import type { FlowConfigService } from '../infrastructure/flow-config.service.js';
import { FlowRunRepository } from '../infrastructure/flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import type { RunsService } from '../../runs/runs.service.js';
import type { FlowConfig } from '../infrastructure/flow-config.interface.js';

/** Wait for all microtasks / async work in the fire-and-forget loop to settle */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('FlowRunnerService', () => {
  let runner: FlowRunnerService;
  let repository: FlowRunRepository;
  let abortTracker: FlowAbortTrackerService;
  let mockResolver: jest.Mock<ReturnType<Resolver>, Parameters<Resolver>>;

  const testConfig: FlowConfig = {
    resolver: './resolve.ts',
    agents: [
      { name: 'dev', target: 'my-repo', prompt: 'Build {{task}}' },
      { name: 'qa', target: 'my-repo', prompt: 'Review {{task}}' },
    ],
  };

  const mockFlowConfigService = {
    loadFlow: jest.fn().mockReturnValue(testConfig),
    getFlowDir: jest.fn().mockReturnValue('/fake/flows/factory'),
  } as unknown as FlowConfigService;

  const mockRunsService = {
    execute: jest.fn().mockResolvedValue({ success: true }),
  } as unknown as RunsService;

  /** Helper: create the row in the repo and start the runner against it. */
  async function startRun(
    flowName: string,
    vars: Record<string, string> = {},
  ): Promise<string> {
    const run = await repository.create(flowName, vars);
    runner.run(run.flowRunId, flowName, vars);
    return run.flowRunId;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new FlowRunRepository();
    abortTracker = new FlowAbortTrackerService();
    mockResolver = jest.fn();

    runner = new FlowRunnerService(
      mockFlowConfigService,
      repository,
      abortTracker,
      mockRunsService,
    );

    // Inject mock resolver instead of doing dynamic import
    jest
      .spyOn(runner as never, 'loadResolver' as never)
      .mockResolvedValue({ resolve: mockResolver } as never);
  });

  it('happy path: resolver returns agent twice then done', async () => {
    mockResolver
      .mockResolvedValueOnce({ agent: 'dev', vars: { task: 'feat-1' } })
      .mockResolvedValueOnce({ agent: 'qa', vars: {} })
      .mockResolvedValueOnce({ done: true, summary: 'All done' });

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('done');
    expect(run.message).toBe('All done');
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].agent).toBe('dev');
    expect(run.steps[0].success).toBe(true);
    expect(run.steps[1].agent).toBe('qa');
    expect(run.steps[1].success).toBe(true);
    expect(mockRunsService.execute).toHaveBeenCalledTimes(2);
  });

  it('escalation: resolver returns escalate immediately', async () => {
    mockResolver.mockResolvedValueOnce({ escalate: 'Stuck on merge conflict' });

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('escalated');
    expect(run.message).toBe('Stuck on merge conflict');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.execute).not.toHaveBeenCalled();
  });

  it('done immediately: resolver returns done', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('done');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.execute).not.toHaveBeenCalled();
  });

  it('agent not found: resolver returns unknown agent name', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'nonexistent',
      vars: {},
    });

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('nonexistent');
    expect(mockRunsService.execute).not.toHaveBeenCalled();
  });

  it('dispatch failure: RunsService.execute throws', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'dev',
      vars: { task: 'feat-1' },
    });
    (mockRunsService.execute as jest.Mock).mockRejectedValueOnce(
      new Error('pi session crashed'),
    );

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('pi session crashed');
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].success).toBe(false);
    expect(run.steps[0].completedAt).toBeInstanceOf(Date);
  });

  it('resolver throws: status errored', async () => {
    mockResolver.mockRejectedValueOnce(new Error('resolver kaboom'));

    const runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('resolver kaboom');
  });

  it('abort mid-loop: status aborted after first dispatch', async () => {
    // eslint-disable-next-line prefer-const -- assigned inside startRun() after mock setup
    let runId: string;

    mockResolver
      .mockImplementationOnce(async () => {
        return { agent: 'dev', vars: { task: 'feat-1' } };
      })
      .mockImplementationOnce(async () => {
        // Abort during second resolver call (after first dispatch)
        abortTracker.abort(runId);
        // Return agent — but abort signal is already set, so loop should exit
        return { agent: 'qa', vars: {} };
      });

    // Make execute slow enough that the second resolver call happens
    (mockRunsService.execute as jest.Mock).mockResolvedValue({
      success: true,
    });

    runId = await startRun('factory');
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('aborted');
  });

  it('vars accumulate across steps', async () => {
    mockResolver
      .mockResolvedValueOnce({ agent: 'dev', vars: { task: 'feat-1' } })
      .mockResolvedValueOnce({
        agent: 'qa',
        vars: { reviewer: 'alice' },
      })
      .mockResolvedValueOnce({ done: true });

    const runId = await startRun('factory', { baseVar: 'hello' });
    await settle();

    const run = (await repository.findById(runId))!;
    expect(run.status).toBe('done');
    expect(run.vars).toEqual({
      baseVar: 'hello',
      task: 'feat-1',
      reviewer: 'alice',
    });

    // Check that prompts were rendered with accumulated vars
    const calls = (mockRunsService.execute as jest.Mock).mock.calls;
    expect(calls[0][0].prompt).toBe('Build feat-1');
    expect(calls[1][0].prompt).toBe('Review feat-1');
  });
});
