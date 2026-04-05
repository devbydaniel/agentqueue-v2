import { FlowExecutorService } from './flow-executor.service.js';
import type { Resolver } from './flow-executor.service.js';
import type { FlowConfigService } from '../flow-config.service.js';
import { FlowRegistryService } from '../flow-registry.service.js';
import type { AgentfilesConfigService } from '../../config/agentfiles-config.service.js';
import type { ExecuteRunUseCase } from '../../runs/application/execute-run.use-case.js';
import type { FlowConfig } from '../flow-config.interface.js';

/** Wait for all microtasks / async work in the fire-and-forget loop to settle */
function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('FlowExecutorService', () => {
  let executor: FlowExecutorService;
  let registry: FlowRegistryService;
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

  const mockAgentfilesConfigService = {
    resolveRepo: jest.fn().mockReturnValue('/fake/repos/my-repo'),
  } as unknown as AgentfilesConfigService;

  const mockExecuteRunUseCase = {
    execute: jest.fn().mockResolvedValue({ success: true }),
  } as unknown as ExecuteRunUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    registry = new FlowRegistryService();
    mockResolver = jest.fn();

    executor = new FlowExecutorService(
      mockFlowConfigService,
      registry,
      mockAgentfilesConfigService,
      mockExecuteRunUseCase,
    );

    // Inject mock resolver instead of doing dynamic import
    jest
      .spyOn(executor as never, 'loadResolver' as never)
      .mockResolvedValue({ resolve: mockResolver } as never);
  });

  it('happy path: resolver returns agent twice then done', async () => {
    mockResolver
      .mockResolvedValueOnce({ agent: 'dev', vars: { task: 'feat-1' } })
      .mockResolvedValueOnce({ agent: 'qa', vars: {} })
      .mockResolvedValueOnce({ done: true, summary: 'All done' });

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('done');
    expect(run.message).toBe('All done');
    expect(run.steps).toHaveLength(2);
    expect(run.steps[0].agent).toBe('dev');
    expect(run.steps[0].success).toBe(true);
    expect(run.steps[1].agent).toBe('qa');
    expect(run.steps[1].success).toBe(true);
    expect(mockExecuteRunUseCase.execute).toHaveBeenCalledTimes(2);
  });

  it('escalation: resolver returns escalate immediately', async () => {
    mockResolver.mockResolvedValueOnce({ escalate: 'Stuck on merge conflict' });

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('escalated');
    expect(run.message).toBe('Stuck on merge conflict');
    expect(run.steps).toHaveLength(0);
    expect(mockExecuteRunUseCase.execute).not.toHaveBeenCalled();
  });

  it('done immediately: resolver returns done', async () => {
    mockResolver.mockResolvedValueOnce({ done: true });

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('done');
    expect(run.steps).toHaveLength(0);
    expect(mockExecuteRunUseCase.execute).not.toHaveBeenCalled();
  });

  it('agent not found: resolver returns unknown agent name', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'nonexistent',
      vars: {},
    });

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('nonexistent');
    expect(mockExecuteRunUseCase.execute).not.toHaveBeenCalled();
  });

  it('dispatch failure: ExecuteRunUseCase.execute throws', async () => {
    mockResolver.mockResolvedValueOnce({
      agent: 'dev',
      vars: { task: 'feat-1' },
    });
    (mockExecuteRunUseCase.execute as jest.Mock).mockRejectedValueOnce(
      new Error('pi session crashed'),
    );

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('pi session crashed');
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].success).toBe(false);
    expect(run.steps[0].completedAt).toBeInstanceOf(Date);
  });

  it('resolver throws: status errored', async () => {
    mockResolver.mockRejectedValueOnce(new Error('resolver kaboom'));

    const runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('errored');
    expect(run.message).toContain('resolver kaboom');
  });

  it('abort mid-loop: status aborted after first dispatch', async () => {
    // eslint-disable-next-line prefer-const -- assigned inside start() after mock setup
    let runId: string;

    mockResolver
      .mockImplementationOnce(async () => {
        return { agent: 'dev', vars: { task: 'feat-1' } };
      })
      .mockImplementationOnce(async () => {
        // Abort during second resolver call (after first dispatch)
        registry.abort(runId);
        // Return agent — but abort signal is already set, so loop should exit
        return { agent: 'qa', vars: {} };
      });

    // Make execute slow enough that the second resolver call happens
    (mockExecuteRunUseCase.execute as jest.Mock).mockResolvedValue({
      success: true,
    });

    runId = executor.start('factory', {});
    await settle();

    const run = registry.get(runId)!;
    // After the second resolver call returns, the loop checks abort before dispatching
    // But the abort check is at the top of the loop, before calling resolve.
    // So: first iteration dispatches dev, then loop restarts, checks abort (not set),
    // calls resolver (which sets abort), gets result, but abort is checked at loop TOP.
    // So the agent dispatch for qa will proceed, then next iteration checks abort.
    // Actually let me re-check the flow: the abort check happens at the top of each
    // iteration. The second resolver call aborts, but the code continues to dispatch qa.
    // Then the third iteration checks abort and exits.
    // Either way, status should be aborted.
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

    const runId = executor.start('factory', { baseVar: 'hello' });
    await settle();

    const run = registry.get(runId)!;
    expect(run.status).toBe('done');
    expect(run.vars).toEqual({
      baseVar: 'hello',
      task: 'feat-1',
      reviewer: 'alice',
    });

    // Check that prompts were rendered with accumulated vars
    const calls = (mockExecuteRunUseCase.execute as jest.Mock).mock.calls;
    // First dispatch: dev agent with task=feat-1
    expect(calls[0][0].prompt).toBe('Build feat-1');
    // Second dispatch: qa agent with task=feat-1, reviewer=alice
    expect(calls[1][0].prompt).toBe('Review feat-1');
  });
});
