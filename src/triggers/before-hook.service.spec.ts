import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { BeforeHookService } from './before-hook.service.js';
import type { AppConfigService } from '../config/app-config.service.js';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'node:child_process';

const mockedSpawn = spawn as unknown as jest.Mock;

interface MockChild extends ChildProcess {
  kill: jest.Mock;
}

function createMockChild(
  exitCode: number | null,
  stdout = '',
  stderr = '',
): MockChild {
  const child = new EventEmitter() as MockChild;
  (child as unknown as { stdin: { end: jest.Mock } }).stdin = {
    end: jest.fn(),
  };
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  child.kill = jest.fn();

  process.nextTick(() => {
    if (stdout) child.stdout!.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr!.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });

  return child;
}

function createHangingChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  (child as unknown as { stdin: { end: jest.Mock } }).stdin = {
    end: jest.fn(),
  };
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  // kill triggers a delayed close so the timeout codepath finishes the promise
  child.kill = jest.fn(() => {
    process.nextTick(() => child.emit('close', null));
    return true;
  });
  return child;
}

describe('BeforeHookService', () => {
  let service: BeforeHookService;
  let appConfig: { beforeHookTimeout: number };

  beforeEach(() => {
    mockedSpawn.mockReset();
    appConfig = { beforeHookTimeout: 30000 };
    service = new BeforeHookService(appConfig as AppConfigService);
  });

  it('returns proceed: true with trimmed stdout when hook exits 0', async () => {
    mockedSpawn.mockReturnValue(createMockChild(0, 'meeting at 10am\n'));

    const result = await service.run(
      '/scripts/check.sh',
      'cron trigger "meeting-prep"',
    );

    expect(result).toEqual({ proceed: true, output: 'meeting at 10am' });
    expect(mockedSpawn).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', '/scripts/check.sh'],
      expect.any(Object),
    );
  });

  it('returns proceed: true with empty output when hook exits 0 with no stdout', async () => {
    mockedSpawn.mockReturnValue(createMockChild(0));

    const result = await service.run('check.sh', 'test');

    expect(result).toEqual({ proceed: true, output: '' });
  });

  it('returns proceed: false when hook exits non-zero', async () => {
    mockedSpawn.mockReturnValue(createMockChild(1, '', 'no meetings'));

    const result = await service.run('check.sh', 'test');

    expect(result).toEqual({ proceed: false, output: '' });
  });

  it('returns proceed: false and SIGTERMs the child when the hook times out', async () => {
    appConfig.beforeHookTimeout = 5;
    const child = createHangingChild();
    mockedSpawn.mockReturnValue(child);

    const result = await service.run('sleep 60', 'test');

    expect(result).toEqual({ proceed: false, output: '' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('returns proceed: false when spawn emits an error event', async () => {
    const child = new EventEmitter() as MockChild;
    (child as unknown as { stdin: { end: jest.Mock } }).stdin = {
      end: jest.fn(),
    };
    (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    child.kill = jest.fn();
    mockedSpawn.mockReturnValue(child);
    process.nextTick(() => child.emit('error', new Error('ENOENT')));

    const result = await service.run('nonexistent', 'test');

    expect(result).toEqual({ proceed: false, output: '' });
  });

  it('does not start a timer when beforeHookTimeout is 0', async () => {
    appConfig.beforeHookTimeout = 0;
    mockedSpawn.mockReturnValue(createMockChild(0, 'ok'));

    const result = await service.run('echo ok', 'test');

    expect(result).toEqual({ proceed: true, output: 'ok' });
  });
});
