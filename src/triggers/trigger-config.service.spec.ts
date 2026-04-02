import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { TriggerConfigService } from './trigger-config.service.js';

jest.mock('node:fs');

describe('TriggerConfigService', () => {
  let service: TriggerConfigService;

  const configPath = path.join(os.homedir(), '.agentqueue', 'triggers.yaml');

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  function createService(): TriggerConfigService {
    return new TriggerConfigService();
  }

  function mockConfigFile(content: object): void {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(yaml.dump(content));
  }

  function mockNoFile(): void {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
  }

  it('should return the correct config path', () => {
    mockNoFile();
    service = createService();
    expect(service.getConfigPath()).toBe(configPath);
  });

  it('should load valid cron triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'daily-review',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Run morning review',
        },
      ],
    });

    service = createService();
    const triggers = service.getCronTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].name).toBe('daily-review');
    expect(triggers[0].schedule).toBe('0 8 * * *');
    expect(triggers[0].target).toBe('assistant');
    expect(triggers[0].prompt).toBe('Run morning review');
  });

  it('should load multiple triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'morning',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Morning task',
        },
        {
          name: 'evening',
          schedule: '0 18 * * *',
          target: 'clerk',
          prompt: 'Evening task',
        },
      ],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(2);
  });

  it('should return empty triggers when file does not exist', () => {
    mockNoFile();
    service = createService();
    expect(service.getCronTriggers()).toEqual([]);
  });

  it('should return empty triggers for null triggers list', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('triggers: null\n');

    service = createService();
    expect(service.getCronTriggers()).toEqual([]);
  });

  it('should return empty triggers for empty triggers list', () => {
    mockConfigFile({ triggers: [] });
    service = createService();
    expect(service.getCronTriggers()).toEqual([]);
  });

  it('should filter out triggers missing name', () => {
    mockConfigFile({
      triggers: [
        { schedule: '0 * * * *', target: 'x', prompt: 'y' },
        { name: 'valid', schedule: '0 * * * *', target: 'x', prompt: 'y' },
      ],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(1);
    expect(service.getCronTriggers()[0].name).toBe('valid');
  });

  it('should filter out triggers missing schedule', () => {
    mockConfigFile({
      triggers: [{ name: 'no-schedule', target: 'x', prompt: 'y' }],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(0);
  });

  it('should filter out triggers missing target', () => {
    mockConfigFile({
      triggers: [{ name: 'no-target', schedule: '0 * * * *', prompt: 'y' }],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(0);
  });

  it('should filter out triggers missing prompt', () => {
    mockConfigFile({
      triggers: [{ name: 'no-prompt', schedule: '0 * * * *', target: 'x' }],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(0);
  });

  it('should handle malformed YAML gracefully', () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      ':\n  - :\n  invalid: [unbalanced\n',
    );

    service = createService();
    expect(service.getCronTriggers()).toEqual([]);
  });

  it('should preserve optional fields', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'with-extras',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Run task',
          agent: 'reviewer',
          before: '/path/to/script.sh',
        },
      ],
    });

    service = createService();
    const trigger = service.getCronTriggers()[0];
    expect(trigger.agent).toBe('reviewer');
    expect(trigger.before).toBe('/path/to/script.sh');
  });

  it('should read from the correct path', () => {
    mockNoFile();
    createService();

    expect(fs.existsSync).toHaveBeenCalledWith(configPath);
  });

  // --- Linear trigger tests ---

  it('should load a single linear trigger', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'my-repo',
          signing_secret: 'secret123',
          api_key: 'lin_api_abc',
        },
      ],
    });

    service = createService();
    const triggers = service.getLinearTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].name).toBe('coding-agent');
    expect(triggers[0].target).toBe('my-repo');
    expect(triggers[0].signing_secret).toBe('secret123');
    expect(triggers[0].api_key).toBe('lin_api_abc');
  });

  it('should load multiple linear triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'repo-a',
          signing_secret: 'secret-a',
          api_key: 'key-a',
        },
        {
          name: 'review-agent',
          type: 'linear',
          target: 'repo-b',
          signing_secret: 'secret-b',
          api_key: 'key-b',
        },
      ],
    });

    service = createService();
    const triggers = service.getLinearTriggers();

    expect(triggers).toHaveLength(2);
    expect(triggers[0].name).toBe('coding-agent');
    expect(triggers[0].target).toBe('repo-a');
    expect(triggers[1].name).toBe('review-agent');
    expect(triggers[1].target).toBe('repo-b');
  });

  it('should look up linear trigger by name', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'repo-a',
          signing_secret: 'secret-a',
          api_key: 'key-a',
        },
        {
          name: 'review-agent',
          type: 'linear',
          target: 'repo-b',
          signing_secret: 'secret-b',
          api_key: 'key-b',
        },
      ],
    });

    service = createService();

    const coding = service.getLinearTrigger('coding-agent');
    expect(coding).toBeDefined();
    expect(coding!.target).toBe('repo-a');
    expect(coding!.signing_secret).toBe('secret-a');

    const review = service.getLinearTrigger('review-agent');
    expect(review).toBeDefined();
    expect(review!.target).toBe('repo-b');

    expect(service.getLinearTrigger('nonexistent')).toBeUndefined();
  });

  it('should return empty array when no linear triggers in config', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'cron-only',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Hello',
        },
      ],
    });

    service = createService();
    expect(service.getLinearTriggers()).toEqual([]);
  });

  it('should return empty array for linear triggers when file does not exist', () => {
    mockNoFile();
    service = createService();
    expect(service.getLinearTriggers()).toEqual([]);
  });

  it('should exclude linear triggers from getCronTriggers()', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'cron-job',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Hello',
        },
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'my-repo',
          signing_secret: 'secret',
          api_key: 'key',
        },
      ],
    });

    service = createService();
    const cron = service.getCronTriggers();

    expect(cron).toHaveLength(1);
    expect(cron[0].name).toBe('cron-job');
  });

  it('should interpolate ${VAR} syntax in linear trigger secrets', () => {
    process.env['TEST_LINEAR_SECRET'] = 'interpolated_secret';
    process.env['TEST_LINEAR_KEY'] = 'interpolated_key';

    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'my-repo',
          signing_secret: '${TEST_LINEAR_SECRET}',
          api_key: '${TEST_LINEAR_KEY}',
        },
      ],
    });

    service = createService();
    const linear = service.getLinearTrigger('coding-agent');

    expect(linear!.signing_secret).toBe('interpolated_secret');
    expect(linear!.api_key).toBe('interpolated_key');

    delete process.env['TEST_LINEAR_SECRET'];
    delete process.env['TEST_LINEAR_KEY'];
  });

  it('should keep ${VAR} as-is if env var is not set', () => {
    delete process.env['NONEXISTENT_VAR'];

    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'my-repo',
          signing_secret: '${NONEXISTENT_VAR}',
          api_key: 'literal_key',
        },
      ],
    });

    service = createService();
    const linear = service.getLinearTrigger('coding-agent');

    expect(linear!.signing_secret).toBe('${NONEXISTENT_VAR}');
    expect(linear!.api_key).toBe('literal_key');
  });

  it('should handle mixed cron and linear triggers correctly', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'morning',
          schedule: '0 8 * * *',
          target: 'assistant',
          prompt: 'Morning',
        },
        {
          name: 'coding-agent',
          type: 'linear',
          target: 'repo-a',
          signing_secret: 'sec',
          api_key: 'key',
        },
        {
          name: 'evening',
          schedule: '0 18 * * *',
          target: 'clerk',
          prompt: 'Evening',
        },
        {
          name: 'review-agent',
          type: 'linear',
          target: 'repo-b',
          signing_secret: 'sec2',
          api_key: 'key2',
        },
      ],
    });

    service = createService();

    expect(service.getCronTriggers()).toHaveLength(2);
    expect(service.getCronTriggers()[0].name).toBe('morning');
    expect(service.getCronTriggers()[1].name).toBe('evening');
    expect(service.getLinearTriggers()).toHaveLength(2);
    expect(service.getLinearTrigger('coding-agent')).toBeDefined();
    expect(service.getLinearTrigger('review-agent')).toBeDefined();
  });

  it('should skip invalid linear trigger (missing signing_secret)', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'bad-agent',
          type: 'linear',
          target: 'my-repo',
          api_key: 'key',
        },
      ],
    });

    service = createService();
    expect(service.getLinearTriggers()).toEqual([]);
  });

  it('should skip invalid linear trigger (missing target)', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'bad-agent',
          type: 'linear',
          signing_secret: 'secret',
          api_key: 'key',
        },
      ],
    });

    service = createService();
    expect(service.getLinearTriggers()).toEqual([]);
  });
});
