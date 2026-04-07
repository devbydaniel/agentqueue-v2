import { FlowRunnerService } from './flow-runner.service.js';
import type { Resolver } from './flow-resolver-loader.service.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import type { RunsService } from '../runs/runs.service.js';
import type { FlowConfig } from './flow-config.service.js';

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

  const mockRunsService = {
    execute: jest.fn().mockResolvedValue({ success: true }),
  } as unknown as RunsService;

  /** Helper: create the row in the repo, track an abort controller, and start the runner. */
  async function startRun(
    flowName: string,
    vars: Record<string, string> = {},
  ): Promise<{ flowRunId: string; abortController: AbortController }> {
    const run = await repository.create(flowName, vars);
    const abortController = new AbortController();
    abortTracker.track(run.flowRunId, abortController);
    runner.run({
      run,
      flowDir: '/fake/flows/factory',
      config: testConfig,
      resolve: mockResolver,
      abortSignal: abortController.signal,
    });
    return { flowRunId: run.flowRunId, abortController };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    repository = new FlowRunRepository();
    abortTracker = new FlowAbortTrackerService();
    mockResolver = jest.fn();

    runner = new FlowRunnerService(repository, abortTracker, mockRunsService);
  });

  it('happy path: resolver returns agent twice then done', async () => {
    mockResolver
      .mockResolvedValueOnce({ agent: 'dev', vars: { task: 'feat-1' } })
      .mockResolvedValueOnce({ agent: 'qa', vars: {} })
      .mockResolvedValueOnce({ done: true, summary: 'All done' });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
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

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('escalated');
    expect(run.message).toBe('Stuck on merge conflict');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.execute).not.toHaveBeenCalled();
  });

  it('done immediately: resolver returns done', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('done');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.execute).not.toHaveBeenCalled();
  });

  it('agent not found: resolver returns unknown agent name', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'nonexistent',
      vars: {},
    });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
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

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('pi session crashed');
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].success).toBe(false);
    expect(run.steps[0].completedAt).toBeInstanceOf(Date);
  });

  it('resolver throws: status errored', async () => {
    mockResolver.mockRejectedValueOnce(new Error('resolver kaboom'));

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
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

    // Make execute resolve quickly so the second resolver call happens
    (mockRunsService.execute as jest.Mock).mockResolvedValue({
      success: true,
    });

    const result = await startRun('factory');
    runId = result.flowRunId;
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

    const { flowRunId } = await startRun('factory', { baseVar: 'hello' });
    await settle();

    const run = (await repository.findById(flowRunId))!;
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

  it('completion untracks the abort controller', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });
    const untrackSpy = jest.spyOn(abortTracker, 'untrack');

    const { flowRunId } = await startRun('factory');
    await settle();

    expect(untrackSpy).toHaveBeenCalledWith(flowRunId);
  });
});
