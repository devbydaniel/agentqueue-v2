import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { RunEventCallbackHandler } from './run-event.callback-handler.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';

describe('RunEventCallbackHandler', () => {
  let handler: RunEventCallbackHandler;
  let mockRepo: jest.Mocked<RunEventRepository>;

  beforeEach(() => {
    mockRepo = {
      append: jest.fn().mockResolvedValue(undefined),
      findByRunId: jest.fn(),
    } as unknown as jest.Mocked<RunEventRepository>;

    handler = new RunEventCallbackHandler('run-123', mockRepo);
  });

  const persistedTypes = [
    'agent_start',
    'agent_end',
    'turn_start',
    'turn_end',
    'message_end',
    'tool_execution_start',
    'tool_execution_end',
    'compaction_start',
    'compaction_end',
    'auto_retry_start',
    'auto_retry_end',
  ];

  const filteredTypes = [
    'message_start',
    'message_update',
    'tool_execution_update',
    'queue_update',
  ];

  it('should have name "run-event"', () => {
    expect(handler.name).toBe('run-event');
  });

  it.each(persistedTypes)('should persist %s events', (type) => {
    handler.onEvent({ type } as AgentSessionEvent);

    expect(mockRepo.append).toHaveBeenCalledWith('run-123', type, null);
  });

  it.each(filteredTypes)('should NOT persist %s events', (type) => {
    handler.onEvent({ type } as AgentSessionEvent);

    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  it('should strip the type field and persist remaining payload', () => {
    handler.onEvent({
      type: 'agent_end',
      messages: ['msg1', 'msg2'],
    } as unknown as AgentSessionEvent);

    expect(mockRepo.append).toHaveBeenCalledWith('run-123', 'agent_end', {
      messages: ['msg1', 'msg2'],
    });
  });

  it('should persist null payload when event has only type', () => {
    handler.onEvent({ type: 'turn_start' } as AgentSessionEvent);

    expect(mockRepo.append).toHaveBeenCalledWith('run-123', 'turn_start', null);
  });

  it('should not throw when repo.append rejects', async () => {
    mockRepo.append.mockRejectedValueOnce(new Error('DB down'));

    // Should not throw — errors are swallowed
    expect(() => {
      handler.onEvent({ type: 'agent_start' } as AgentSessionEvent);
    }).not.toThrow();

    // Give the promise rejection a tick to be caught
    await new Promise((r) => setTimeout(r, 10));
  });

  it('should use the correct runId for all events', () => {
    const handler2 = new RunEventCallbackHandler('run-456', mockRepo);
    handler2.onEvent({ type: 'agent_start' } as AgentSessionEvent);

    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-456',
      'agent_start',
      null,
    );
  });
});
