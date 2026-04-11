import { RunEventCallbackHandler } from './run-event.callback-handler.js';
import type { RunEventRepository } from '../../runs/run-event.repository.js';
import {
  assistantText,
  assistantToolUse,
  resultSuccess,
  resultError,
  systemInit,
  systemApiRetry,
  systemCompactBoundary,
  systemStatus,
  streamEvent,
  toolProgress,
  userToolResult,
} from './__tests__/sdk-message.fixtures.js';

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

  // ── Persisted message types ──────────────────────────────────────

  it('should persist assistant messages', () => {
    handler.onMessage(assistantText('Hello'));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'assistant',
      expect.objectContaining({ message: expect.any(Object) }),
    );
  });

  it('should persist user messages', () => {
    handler.onMessage(userToolResult('tu-1', 'result text'));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'user',
      expect.objectContaining({ message: expect.any(Object) }),
    );
  });

  it('should persist result messages', () => {
    handler.onMessage(resultSuccess());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'result',
      expect.objectContaining({ subtype: 'success' }),
    );
  });

  it('should persist error result messages', () => {
    handler.onMessage(resultError(['Test error']));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'result',
      expect.objectContaining({
        subtype: 'error_during_execution',
        errors: ['Test error'],
      }),
    );
  });

  // ── Persisted system subtypes ────────────────────────────────────

  it('should persist system:init messages', () => {
    handler.onMessage(systemInit());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'system:init',
      expect.objectContaining({ subtype: 'init', model: expect.any(String) }),
    );
  });

  it('should persist system:api_retry messages', () => {
    handler.onMessage(systemApiRetry());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'system:api_retry',
      expect.objectContaining({ subtype: 'api_retry', attempt: 1 }),
    );
  });

  it('should persist system:compact_boundary messages', () => {
    handler.onMessage(systemCompactBoundary());
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'system:compact_boundary',
      expect.objectContaining({ subtype: 'compact_boundary' }),
    );
  });

  it('should persist system:status messages', () => {
    handler.onMessage(systemStatus('compacting'));
    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-123',
      'system:status',
      expect.objectContaining({ subtype: 'status', status: 'compacting' }),
    );
  });

  // ── Skipped message types ────────────────────────────────────────

  it('should NOT persist stream_event messages', () => {
    handler.onMessage(streamEvent());
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  it('should NOT persist tool_progress messages', () => {
    handler.onMessage(toolProgress());
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  // ── Skipped system subtypes ──────────────────────────────────────

  it('should NOT persist hook system messages', () => {
    handler.onMessage({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'h-1',
      hook_name: 'pre-commit',
      hook_event: 'Bash',
      uuid: '00000000-0000-0000-0000-000000000000',
      session_id: 'test',
    } as never);
    expect(mockRepo.append).not.toHaveBeenCalled();
  });

  // ── Payload extraction ───────────────────────────────────────────

  it('should strip type, uuid, and session_id from payload', () => {
    handler.onMessage(assistantToolUse('Read', { path: '/test.ts' }));

    const payload = mockRepo.append.mock.calls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('type');
    expect(payload).not.toHaveProperty('uuid');
    expect(payload).not.toHaveProperty('session_id');
    expect(payload).toHaveProperty('message');
  });

  // ── Error resilience ─────────────────────────────────────────────

  it('should not throw when repo.append rejects', async () => {
    mockRepo.append.mockRejectedValueOnce(new Error('DB down'));

    expect(() => {
      handler.onMessage(assistantText('Hello'));
    }).not.toThrow();

    // Give the promise rejection a tick to be caught
    await new Promise((r) => setTimeout(r, 10));
  });

  it('should use the correct runId for all events', () => {
    const handler2 = new RunEventCallbackHandler('run-456', mockRepo);
    handler2.onMessage(resultSuccess());

    expect(mockRepo.append).toHaveBeenCalledWith(
      'run-456',
      'result',
      expect.any(Object),
    );
  });
});
