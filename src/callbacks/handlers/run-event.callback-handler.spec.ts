import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent' with {
  'resolution-mode': 'import',
};
import { RunEventCallbackHandler } from './run-event.callback-handler.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';
import type { AgentMessage } from '../pi-messages.js';
import { SKIPPED_EVENT_TYPES } from '../callback.constants.js';
import {
  assistantText,
  assistantToolCall,
  autoRetryStart,
  compactionStart,
  messageEnd,
  messageUpdate,
  sessionStart,
  toolResult,
} from './__tests__/pi-event.fixtures.js';

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

  it('should have name "run-event"', () => {
    expect(handler.name).toBe('run-event');
  });

  // ── Session start ────────────────────────────────────────────────

  it('should persist session_start from onStart', () => {
    handler.onStart(sessionStart());
    expect(mockRepo.append).toHaveBeenCalledWith('run-123', 'session_start', {
      sessionId: 'test-session-id',
      model: 'anthropic/claude-opus-5-5',
      tools: ['read', 'bash', 'edit', 'write'],
    });
  });

  // ── Completed messages ───────────────────────────────────────────

  it('should persist assistant messages as message:assistant', () => {
    handler.onEvent(assistantText('Hello'));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'message:assistant',
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      }),
    );
  });

  it('should persist tool results as message:toolResult', () => {
    handler.onEvent(toolResult('tc-1', 'result text'));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'message:toolResult',
      expect.objectContaining({ role: 'toolResult', toolCallId: 'tc-1' }),
    );
  });

  it('should use the message itself as the payload', () => {
    handler.onEvent(assistantToolCall('read', { path: '/test.ts' }));

    const payload = mockRepo.append.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('type');
    expect(payload).not.toHaveProperty('message');
    expect(payload).toHaveProperty('stopReason', 'toolUse');
  });

  it('should NOT persist system-role messages', () => {
    handler.onEvent(
      messageEnd({
        role: 'system',
        content: 'prompt',
        timestamp: 0,
      } as AgentMessage),
    );
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  // ── Other pi events ──────────────────────────────────────────────

  it('should persist auto_retry_start with type stripped from the payload', () => {
    handler.onEvent(autoRetryStart());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'auto_retry_start',
      {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'overloaded',
      },
    );
  });

  it('should persist compaction_start with type stripped from the payload', () => {
    handler.onEvent(compactionStart());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'compaction_start',
      { reason: 'threshold' },
    );
  });

  it('should persist a null payload for events with no fields besides type', () => {
    handler.onEvent({ type: 'summarization_retry_finished' });
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'summarization_retry_finished',
      null,
    );
  });

  // ── Skipped event types ──────────────────────────────────────────

  it('should NOT persist streaming message_update partials', () => {
    handler.onEvent(messageUpdate());
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  it.each([...SKIPPED_EVENT_TYPES])('should NOT persist %s events', (type) => {
    handler.onEvent({ type } as AgentSessionEvent);
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  // ── Error resilience ─────────────────────────────────────────────

  it('should not throw when repo.append rejects', async () => {
    mockRepo.append.mockRejectedValueOnce(new Error('DB down'));

    expect(() => {
      handler.onEvent(assistantText('Hello'));
    }).not.toThrow();

    // Give the promise rejection a tick to be caught
    await new Promise((r) => setTimeout(r, 10));
  });

  it('should use the correct runId for all events', () => {
    const handler2 = new RunEventCallbackHandler('run-456', mockRepo);
    handler2.onEvent(assistantText('Hello'));

    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-456',
      'message:assistant',
      expect.any(Object),
    );
  });
});
