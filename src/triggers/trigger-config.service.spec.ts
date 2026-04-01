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
});
