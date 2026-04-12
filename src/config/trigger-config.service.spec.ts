/* eslint-disable sonarjs/publicly-writable-directories */
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
    const instance = new TriggerConfigService();
    instance.onModuleInit();
    return instance;
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
          cwd: '/tmp/assistant',
          prompt: 'Run morning review',
        },
      ],
    });

    service = createService();
    const triggers = service.getCronTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].name).toBe('daily-review');
    expect(triggers[0].schedule).toBe('0 8 * * *');
    expect(triggers[0].cwd).toBe('/tmp/assistant');
    expect(triggers[0].prompt).toBe('Run morning review');
  });

  it('should load multiple triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'morning',
          schedule: '0 8 * * *',
          cwd: '/tmp/assistant',
          prompt: 'Morning task',
        },
        {
          name: 'evening',
          schedule: '0 18 * * *',
          cwd: '/tmp/clerk',
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
        { schedule: '0 * * * *', cwd: '/tmp/x', prompt: 'y' },
        { name: 'valid', schedule: '0 * * * *', cwd: '/tmp/x', prompt: 'y' },
      ],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(1);
    expect(service.getCronTriggers()[0].name).toBe('valid');
  });

  it('should filter out triggers missing schedule', () => {
    mockConfigFile({
      triggers: [{ name: 'no-schedule', cwd: '/tmp/x', prompt: 'y' }],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(0);
  });

  it('should filter out triggers missing cwd', () => {
    mockConfigFile({
      triggers: [{ name: 'no-cwd', schedule: '0 * * * *', prompt: 'y' }],
    });

    service = createService();
    expect(service.getCronTriggers()).toHaveLength(0);
  });

  it('should filter out triggers missing prompt', () => {
    mockConfigFile({
      triggers: [{ name: 'no-prompt', schedule: '0 * * * *', cwd: '/tmp/x' }],
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
          cwd: '/tmp/assistant',
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
          cwd: '/tmp/my-repo',
          signing_secret: 'secret123',
          api_key: 'lin_api_abc',
        },
      ],
    });

    service = createService();
    const triggers = service.getLinearTriggers();

    expect(triggers).toHaveLength(1);
    expect(triggers[0].name).toBe('coding-agent');
    expect(triggers[0].cwd).toBe('/tmp/my-repo');
    expect(triggers[0].signing_secret).toBe('secret123');
    expect(triggers[0].api_key).toBe('lin_api_abc');
  });

  it('should load multiple linear triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/repo-a',
          signing_secret: 'secret-a',
          api_key: 'key-a',
        },
        {
          name: 'review-agent',
          type: 'linear',
          cwd: '/tmp/repo-b',
          signing_secret: 'secret-b',
          api_key: 'key-b',
        },
      ],
    });

    service = createService();
    const triggers = service.getLinearTriggers();

    expect(triggers).toHaveLength(2);
    expect(triggers[0].name).toBe('coding-agent');
    expect(triggers[0].cwd).toBe('/tmp/repo-a');
    expect(triggers[1].name).toBe('review-agent');
    expect(triggers[1].cwd).toBe('/tmp/repo-b');
  });

  it('should look up linear trigger by name', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/repo-a',
          signing_secret: 'secret-a',
          api_key: 'key-a',
        },
        {
          name: 'review-agent',
          type: 'linear',
          cwd: '/tmp/repo-b',
          signing_secret: 'secret-b',
          api_key: 'key-b',
        },
      ],
    });

    service = createService();

    const coding = service.getLinearTrigger('coding-agent');
    expect(coding).toBeDefined();
    expect(coding!.cwd).toBe('/tmp/repo-a');
    expect(coding!.signing_secret).toBe('secret-a');

    const review = service.getLinearTrigger('review-agent');
    expect(review).toBeDefined();
    expect(review!.cwd).toBe('/tmp/repo-b');

    expect(service.getLinearTrigger('nonexistent')).toBeUndefined();
  });

  it('should return empty array when no linear triggers in config', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'cron-only',
          schedule: '0 8 * * *',
          cwd: '/tmp/assistant',
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
          cwd: '/tmp/assistant',
          prompt: 'Hello',
        },
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/my-repo',
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
          cwd: '/tmp/my-repo',
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
          cwd: '/tmp/my-repo',
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
          cwd: '/tmp/assistant',
          prompt: 'Morning',
        },
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/repo-a',
          signing_secret: 'sec',
          api_key: 'key',
        },
        {
          name: 'evening',
          schedule: '0 18 * * *',
          cwd: '/tmp/clerk',
          prompt: 'Evening',
        },
        {
          name: 'review-agent',
          type: 'linear',
          cwd: '/tmp/repo-b',
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
          cwd: '/tmp/my-repo',
          api_key: 'key',
        },
      ],
    });

    service = createService();
    expect(service.getLinearTriggers()).toEqual([]);
  });

  it('should skip invalid linear trigger (missing cwd)', () => {
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

  // --- system prompt fields ---

  it('should parse append_system_prompt for cron triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'with-prompts',
          schedule: '0 8 * * *',
          cwd: '/tmp/assistant',
          prompt: 'Hello',
          append_system_prompt: 'Always be concise.',
        },
      ],
    });

    service = createService();
    const trigger = service.getCronTriggers()[0];
    expect(trigger.append_system_prompt).toBe('Always be concise.');
  });

  it('should leave append_system_prompt undefined for cron triggers when not set', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'no-prompts',
          schedule: '0 8 * * *',
          cwd: '/tmp/assistant',
          prompt: 'Hello',
        },
      ],
    });

    service = createService();
    const trigger = service.getCronTriggers()[0];
    expect(trigger.append_system_prompt).toBeUndefined();
  });

  it('should parse append_system_prompt for linear triggers', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/my-repo',
          signing_secret: 'secret',
          api_key: 'key',
          append_system_prompt: 'Post updates back to Linear.',
        },
      ],
    });

    service = createService();
    const trigger = service.getLinearTrigger('coding-agent');
    expect(trigger!.append_system_prompt).toBe('Post updates back to Linear.');
  });

  it('should leave append_system_prompt undefined for linear triggers when not set', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'coding-agent',
          type: 'linear',
          cwd: '/tmp/my-repo',
          signing_secret: 'secret',
          api_key: 'key',
        },
      ],
    });

    service = createService();
    const trigger = service.getLinearTrigger('coding-agent');
    expect(trigger!.append_system_prompt).toBeUndefined();
  });

  // --- Telegram trigger tests ---

  it('should load telegram triggers and normalize numeric IDs to strings', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'daniel-assistant',
          type: 'telegram',
          bot_name: 'main-bot',
          bot_token: 'bot-token',
          webhook_secret: 'secret',
          user_id: 456,
          chat_id: 123,
          cwd: '/tmp/assistant',
        },
      ],
    });

    service = createService();
    const trigger = service.getTelegramTrigger('daniel-assistant');

    expect(trigger).toBeDefined();
    expect(trigger!.user_id).toBe('456');
    expect(trigger!.chat_id).toBe('123');
  });

  it('should return telegram triggers by bot name', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'daniel-assistant',
          type: 'telegram',
          bot_name: 'main-bot',
          bot_token: 'bot-token',
          webhook_secret: 'secret',
          user_id: '456',
          cwd: '/tmp/assistant',
        },
        {
          name: 'ops-assistant',
          type: 'telegram',
          bot_name: 'ops-bot',
          bot_token: 'ops-token',
          webhook_secret: 'ops-secret',
          user_id: '789',
          cwd: '/tmp/ops',
        },
      ],
    });

    service = createService();

    expect(service.getTelegramTriggersForBot('main-bot')).toHaveLength(1);
    expect(service.getTelegramTriggersForBot('main-bot')[0].name).toBe(
      'daniel-assistant',
    );
  });

  it('should interpolate env vars in telegram bot credentials', () => {
    process.env['TEST_TELEGRAM_BOT_TOKEN'] = 'interpolated_bot_token';
    process.env['TEST_TELEGRAM_SECRET'] = 'interpolated_secret';

    mockConfigFile({
      triggers: [
        {
          name: 'daniel-assistant',
          type: 'telegram',
          bot_name: 'main-bot',
          bot_token: '${TEST_TELEGRAM_BOT_TOKEN}',
          webhook_secret: '${TEST_TELEGRAM_SECRET}',
          user_id: '456',
          cwd: '/tmp/assistant',
        },
      ],
    });

    service = createService();
    const bot = service.getTelegramBotConfig('main-bot');

    expect(bot).toEqual({
      botName: 'main-bot',
      botToken: 'interpolated_bot_token',
      webhookSecret: 'interpolated_secret',
    });

    delete process.env['TEST_TELEGRAM_BOT_TOKEN'];
    delete process.env['TEST_TELEGRAM_SECRET'];
  });

  it('should skip invalid telegram triggers missing required fields', () => {
    mockConfigFile({
      triggers: [
        {
          name: 'bad-telegram',
          type: 'telegram',
          bot_name: 'main-bot',
          user_id: '456',
          cwd: '/tmp/assistant',
        },
      ],
    });

    service = createService();

    expect(service.getTelegramTriggers()).toEqual([]);
    expect(service.getTelegramBotConfig('main-bot')).toBeUndefined();
  });
});
