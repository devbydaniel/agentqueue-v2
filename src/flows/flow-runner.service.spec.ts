import { FlowRunnerService } from './flow-runner.service.js';
import type { Resolver } from './flow-resolver-loader.service.js';
import { FlowRunRepository } from './flow-run.repository.js';
import { FlowAbortTrackerService } from './flow-abort-tracker.service.js';
import type { RunsService } from '../runs/runs.service.js';
import type { FlowRunCompletionListener } from './flow-run-completion.listener.js';
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

  let runIdCounter = 0;

  const mockRunsService = {
    enqueue: jest.fn().mockImplementation(() => {
      runIdCounter++;
      return Promise.resolve({
        runId: `run-${runIdCounter}`,
        status: 'waiting',
      });
    }),
  } as unknown as RunsService;

  const mockCompletionListener = {
    waitFor: jest
      .fn()
      .mockResolvedValue({ status: 'succeeded', runId: 'run-1' }),
  } as unknown as FlowRunCompletionListener;

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
    runIdCounter = 0;
    repository = new FlowRunRepository();
    abortTracker = new FlowAbortTrackerService();
    mockResolver = jest.fn();

    runner = new FlowRunnerService(
      repository,
      abortTracker,
      mockRunsService,
      mockCompletionListener,
    );
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
    expect(run.steps[0].runId).toBe('run-1');
    expect(run.steps[1].agent).toBe('qa');
    expect(run.steps[1].success).toBe(true);
    expect(run.steps[1].runId).toBe('run-2');
    expect(mockRunsService.enqueue).toHaveBeenCalledTimes(2);
    expect(mockCompletionListener.waitFor).toHaveBeenCalledTimes(2);
  });

  it('escalation: resolver returns escalate immediately', async () => {
    mockResolver.mockResolvedValueOnce({ escalate: 'Stuck on merge conflict' });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('escalated');
    expect(run.message).toBe('Stuck on merge conflict');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.enqueue).not.toHaveBeenCalled();
  });

  it('done immediately: resolver returns done', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('done');
    expect(run.steps).toHaveLength(0);
    expect(mockRunsService.enqueue).not.toHaveBeenCalled();
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
    expect(mockRunsService.enqueue).not.toHaveBeenCalled();
  });

  it('dispatch failure: enqueue throws', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'dev',
      vars: { task: 'feat-1' },
    });
    (mockRunsService.enqueue as jest.Mock).mockRejectedValueOnce(
      new Error('queue unavailable'),
    );

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('queue unavailable');
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

    // Make enqueue resolve quickly so the second resolver call happens
    (mockRunsService.enqueue as jest.Mock).mockResolvedValue({
      runId: 'run-abort',
      status: 'waiting',
    });
    (mockCompletionListener.waitFor as jest.Mock).mockResolvedValue({
      status: 'succeeded',
      runId: 'run-abort',
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
    const calls = (mockRunsService.enqueue as jest.Mock).mock.calls;
    expect(calls[0][0].prompt).toBe('Build feat-1');
    expect(calls[1][0].prompt).toBe('Review feat-1');
  });

  it('step failure from run errored status marks flow errored', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'dev',
      vars: { task: 'feat-1' },
    });
    (mockCompletionListener.waitFor as jest.Mock).mockResolvedValueOnce({
      status: 'errored',
      errorMessage: 'session crashed',
      runId: 'run-1',
    });

    const { flowRunId } = await startRun('factory');
    await settle();

    const run = (await repository.findById(flowRunId))!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('session crashed');
    expect(run.steps[0].success).toBe(false);
  });

  it('enqueue includes source=flow and parentFlowRunId', async () => {
    mockResolver
      .mockResolvedValueOnce({ agent: 'dev', vars: { task: 'feat-1' } })
      .mockResolvedValueOnce({ done: true });

    const { flowRunId } = await startRun('factory');
    await settle();

    expect(mockRunsService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'flow',
        parentFlowRunId: flowRunId,
        repo: 'my-repo',
        prompt: 'Build feat-1',
      }),
    );
  });

  it('completion untracks the abort controller', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });
    const untrackSpy = jest.spyOn(abortTracker, 'untrack');

    const { flowRunId } = await startRun('factory');
    await settle();

    expect(untrackSpy).toHaveBeenCalledWith(flowRunId);
  });
});
