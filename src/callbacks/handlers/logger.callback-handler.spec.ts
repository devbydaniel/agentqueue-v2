import { Logger } from '@nestjs/common';
import { LoggerCallbackHandler } from './logger.callback-handler.js';
import {
  agentSettled,
  assistantError,
  assistantMixed,
  assistantText,
  autoRetryStart,
  compactionStart,
  messageUpdate,
  sessionStart,
  toolResult,
} from './__tests__/pi-event.fixtures.js';

describe('LoggerCallbackHandler', () => {
  let handler: LoggerCallbackHandler;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    handler = new LoggerCallbackHandler();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should have name "logger"', () => {
    expect(handler.name).toBe('logger');
  });

  it('should log session facts on start', () => {
    handler.onStart(sessionStart());

    expect(log).toHaveBeenCalledWith('Session started', {
      sessionId: 'test-session-id',
      model: 'anthropic/claude-opus-5-5',
      toolCount: 4,
    });
  });

  it('should log assistant text and tool calls', () => {
    handler.onEvent(assistantMixed('Reading it.', 'read', { path: '/a.ts' }));

    expect(log).toHaveBeenCalledWith('Assistant message', {
      text: 'Reading it.',
    });
    expect(log).toHaveBeenCalledWith('Tool call: read', {
      args: '{"path":"/a.ts"}',
    });
  });

  it('should truncate long assistant text', () => {
    handler.onEvent(assistantText('x'.repeat(600)));

    expect(log).toHaveBeenCalledWith('Assistant message', {
      text: 'x'.repeat(500) + '… (600 chars total)',
    });
  });

  it('should warn on API retry', () => {
    handler.onEvent(autoRetryStart());

    expect(warn).toHaveBeenCalledWith('API retry', {
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      error: 'overloaded',
    });
  });

  it('should log compaction and settlement', () => {
    handler.onEvent(compactionStart());
    handler.onEvent(agentSettled());

    expect(log).toHaveBeenCalledWith('Context compacting', {
      reason: 'threshold',
    });
    expect(log).toHaveBeenCalledWith('Run settled');
  });

  it('should log an error when the assistant turn failed', () => {
    handler.onEvent(assistantError('rate limited'));

    expect(error).toHaveBeenCalledWith('Assistant turn failed', {
      error: 'rate limited',
    });
    expect(log).not.toHaveBeenCalledWith(
      'Assistant message',
      expect.anything(),
    );
  });

  it('should not log tool results or streaming partials', () => {
    handler.onEvent(toolResult('tc-1', 'output'));
    handler.onEvent(messageUpdate());

    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
