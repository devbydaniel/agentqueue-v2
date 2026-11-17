/* eslint-disable sonarjs/publicly-writable-directories */
import { Logger } from '@nestjs/common';
import * as fs from 'node:fs';
import * as yaml from 'js-yaml';
import { TriggerConfigService } from './trigger-config.service.js';

jest.mock('node:fs');

const cron = (extra: Record<string, unknown> = {}) => ({
  name: 'nightly',
  schedule: '0 2 * * *',
  cwd: '/tmp/assistant',
  prompt: 'Run the nightly job',
  ...extra,
});

const github = (extra: Record<string, unknown> = {}) => ({
  name: 'pr-gate',
  type: 'github',
  events: ['issue_comment'],
  cwd: '/tmp/core',
  prompt: 'Gate PR {{issue.number}}',
  ...extra,
});

describe('TriggerConfigService queues', () => {
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.restoreAllMocks();
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
  });

  function load(content: object): TriggerConfigService {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(yaml.dump(content));
    const service = new TriggerConfigService();
    service.onModuleInit();
    return service;
  }

  it('loads a config without queues exactly as before', () => {
    const service = load({ triggers: [cron(), github()] });

    expect(service.getQueues()).toEqual([]);
    expect(service.getCronTriggers()[0]).not.toHaveProperty('queue');
    expect(service.getGithubTriggers()[0]).not.toHaveProperty('queue');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('loads queues and the queue named by each trigger', () => {
    const service = load({
      queues: { gate: { concurrency: 2 }, nightly: { concurrency: 1 } },
      triggers: [cron({ queue: 'nightly' }), github({ queue: 'gate' })],
    });

    expect(service.getQueues()).toEqual([
      { name: 'gate', concurrency: 2 },
      { name: 'nightly', concurrency: 1 },
    ]);
    expect(service.getCronTriggers()[0].queue).toBe('nightly');
    expect(service.getGithubTriggers()[0].queue).toBe('gate');
  });

  it('accepts the default queue by name', () => {
    const service = load({ triggers: [cron({ queue: 'runs' })] });

    expect(service.getCronTriggers()[0].queue).toBe('runs');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('reads queue on every trigger type', () => {
    const service = load({
      queues: { side: { concurrency: 1 } },
      triggers: [
        cron({ queue: 'side' }),
        github({ queue: 'side' }),
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/core',
          signing_secret: 's',
          api_key: 'k',
          queue: 'side',
        },
        {
          name: 'tg',
          type: 'telegram',
          bot_name: 'bot',
          bot_token: 't',
          user_id: '1',
          cwd: '/tmp/assistant',
          queue: 'side',
        },
        {
          name: 'sl',
          type: 'slack',
          bot_name: 'bot',
          bot_token: 't',
          signing_secret: 's',
          user_id: 'U1',
          cwd: '/tmp/assistant',
          queue: 'side',
        },
        {
          name: 'mx',
          type: 'matrix',
          bot_name: 'bot',
          homeserver_url: 'https://hs.example',
          access_token: 't',
          user_id: '@d:hs',
          cwd: '/tmp/assistant',
          queue: 'side',
        },
      ],
    });

    const all = [
      ...service.getCronTriggers(),
      ...service.getGithubTriggers(),
      ...service.getLinearTriggers(),
      ...service.getTelegramTriggers(),
      ...service.getSlackTriggers(),
      ...service.getMatrixTriggers(),
    ];
    expect(all).toHaveLength(6);
    expect(all.every((t) => t.queue === 'side')).toBe(true);
  });

  it('fails loading when a trigger names an undefined queue', () => {
    const service = load({
      queues: { gate: { concurrency: 2 } },
      triggers: [cron(), github({ queue: 'gaet' })],
    });

    expect(errorSpy).toHaveBeenCalledWith(
      'Failed to load triggers config: Trigger "pr-gate" names undefined queue "gaet"; define it under "queues"',
    );
    // No fallback: nothing is loaded, not even the valid trigger.
    expect(service.getGithubTriggers()).toEqual([]);
    expect(service.getCronTriggers()).toEqual([]);
    expect(service.getQueues()).toEqual([]);
  });

  it('fails loading when queue is not a string', () => {
    load({ triggers: [cron({ queue: 3 })] });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Trigger "nightly" names undefined queue 3;'),
    );
  });

  it('ignores the queue of a paused trigger', () => {
    const service = load({
      triggers: [cron(), github({ queue: 'gone', paused: true })],
    });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(service.getCronTriggers()).toHaveLength(1);
  });

  it.each([
    [
      { gate: { concurrency: 0 } },
      'Queue "gate" needs a concurrency of at least 1',
    ],
    [
      { gate: { concurrency: 1.5 } },
      'Queue "gate" needs a concurrency of at least 1',
    ],
    [{ gate: {} }, 'Queue "gate" needs a concurrency of at least 1'],
    [{ gate: null }, 'Queue "gate" needs a concurrency of at least 1'],
    [{ 'g ate': { concurrency: 1 } }, 'Queue "g ate" may only contain'],
    [{ runs: { concurrency: 9 } }, 'Queue "runs" is the default queue'],
    [['gate'], '"queues" must be a map'],
  ])('fails loading for queues %j', (queues, message) => {
    const service = load({ queues, triggers: [cron()] });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(service.getCronTriggers()).toEqual([]);
  });
});
