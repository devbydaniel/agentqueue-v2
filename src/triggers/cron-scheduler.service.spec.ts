import * as cron from 'node-cron';
import { CronSchedulerService } from './cron-scheduler.service.js';
import type { TriggerConfigService } from './trigger-config.service.js';
import type { ExecuteRunUseCase } from '../runs/application/execute-run.use-case.js';
import type { CronTrigger } from './trigger-config.interface.js';
import type { BeforeHookService } from './before-hook.service.js';

jest.mock('node-cron');

describe('CronSchedulerService', () => {
  let scheduler: CronSchedulerService;
  let triggerConfigService: jest.Mocked<TriggerConfigService>;
  let executeRunUseCase: jest.Mocked<ExecuteRunUseCase>;
  let beforeHookService: jest.Mocked<BeforeHookService>;
  let mockTask: { stop: jest.Mock };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();

    mockTask = { stop: jest.fn() };

    triggerConfigService = {
      getCronTriggers: jest.fn().mockReturnValue([]),
      getConfigPath: jest.fn(),
    } as unknown as jest.Mocked<TriggerConfigService>;

    executeRunUseCase = {
      execute: jest.fn().mockResolvedValue({ success: true }),
    } as unknown as jest.Mocked<ExecuteRunUseCase>;

    beforeHookService = {
      run: jest.fn().mockResolvedValue({ proceed: true, output: '' }),
    } as unknown as jest.Mocked<BeforeHookService>;

    scheduler = new CronSchedulerService(
      triggerConfigService,
      executeRunUseCase,
      beforeHookService,
    );
  });

  function makeTrigger(overrides: Partial<CronTrigger> = {}): CronTrigger {
    return {
      name: 'test-trigger',
      schedule: '0 8 * * *',
      target: 'assistant',
      prompt: 'Run test',
      ...overrides,
    };
  }

  describe('onModuleInit', () => {
    it('should register cron tasks for valid triggers', () => {
      triggerConfigService.getCronTriggers.mockReturnValue([makeTrigger()]);
      (cron.validate as jest.Mock).mockReturnValue(true);
      (cron.schedule as jest.Mock).mockReturnValue(mockTask);

      scheduler.onModuleInit();

      expect(cron.schedule).toHaveBeenCalledWith(
        '0 8 * * *',
        expect.any(Function),
      );
    });

    it('should skip triggers with invalid cron schedules', () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({ schedule: 'not-a-cron' }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(false);

      scheduler.onModuleInit();

      expect(cron.schedule).not.toHaveBeenCalled();
    });

    it('should register multiple triggers', () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({ name: 'first' }),
        makeTrigger({ name: 'second', schedule: '*/5 * * * *' }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);
      (cron.schedule as jest.Mock).mockReturnValue(mockTask);

      scheduler.onModuleInit();

      expect(cron.schedule).toHaveBeenCalledTimes(2);
    });

    it('should handle no triggers gracefully', () => {
      triggerConfigService.getCronTriggers.mockReturnValue([]);

      scheduler.onModuleInit();

      expect(cron.schedule).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should stop all registered tasks', () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger(),
        makeTrigger({ name: 'second' }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      const task1 = { stop: jest.fn() };
      const task2 = { stop: jest.fn() };
      (cron.schedule as jest.Mock)
        .mockReturnValueOnce(task1)
        .mockReturnValueOnce(task2);

      scheduler.onModuleInit();
      scheduler.onModuleDestroy();

      expect(task1.stop).toHaveBeenCalled();
      expect(task2.stop).toHaveBeenCalled();
    });

    it('should handle destroy with no tasks', () => {
      expect(() => scheduler.onModuleDestroy()).not.toThrow();
    });
  });

  describe('cron tick handler', () => {
    it('should call executeRunUseCase when cron fires', async () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({ target: 'myrepo', prompt: 'Do something' }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      let tickHandler: () => Promise<void>;
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });

      scheduler.onModuleInit();

      await tickHandler!();

      expect(executeRunUseCase.execute).toHaveBeenCalledWith({
        repo: 'myrepo',
        prompt: 'Do something',
        prependSystemPrompt: undefined,
        appendSystemPrompt: undefined,
      });
    });

    it('should not throw when executeRunUseCase fails', async () => {
      triggerConfigService.getCronTriggers.mockReturnValue([makeTrigger()]);
      (cron.validate as jest.Mock).mockReturnValue(true);
      executeRunUseCase.execute.mockRejectedValue(new Error('Run failed'));

      let tickHandler: () => Promise<void>;
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });

      scheduler.onModuleInit();
      // Should not throw — errors are caught and logged internally

      await tickHandler!();

      expect(executeRunUseCase.execute).toHaveBeenCalled();
    });

    it('should pass interpolated prepend_system_prompt to execute', async () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({
          target: 'myrepo',
          prompt: 'Do something',
          prepend_system_prompt: 'Trigger: {{triggerName}}, target: {{target}}',
        }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      let tickHandler: () => Promise<void>;
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });

      scheduler.onModuleInit();
      await tickHandler!();

      expect(executeRunUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prependSystemPrompt: 'Trigger: test-trigger, target: myrepo',
        }),
      );
    });

    it('should pass interpolated append_system_prompt to execute', async () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({
          target: 'myrepo',
          prompt: 'Do something',
          append_system_prompt: 'Schedule: {{schedule}}',
        }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      let tickHandler: () => Promise<void>;
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });

      scheduler.onModuleInit();
      await tickHandler!();

      expect(executeRunUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          appendSystemPrompt: 'Schedule: 0 8 * * *',
        }),
      );
    });

    it('should not pass system prompt fields when trigger has no templates', async () => {
      triggerConfigService.getCronTriggers.mockReturnValue([
        makeTrigger({ target: 'myrepo', prompt: 'Do something' }),
      ]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      let tickHandler: () => Promise<void>;
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });

      scheduler.onModuleInit();
      await tickHandler!();

      const call = executeRunUseCase.execute.mock
        .calls[0][0] as unknown as Record<string, unknown>;
      expect(call['prependSystemPrompt']).toBeUndefined();
      expect(call['appendSystemPrompt']).toBeUndefined();
    });
  });

  describe('before hook', () => {
    function setupTickHandler(trigger: CronTrigger): () => Promise<void> {
      triggerConfigService.getCronTriggers.mockReturnValue([trigger]);
      (cron.validate as jest.Mock).mockReturnValue(true);

      let tickHandler: () => Promise<void> = () => Promise.resolve();
      (cron.schedule as jest.Mock).mockImplementation((_schedule, handler) => {
        tickHandler = handler as () => Promise<void>;
        return mockTask;
      });
      scheduler.onModuleInit();
      return tickHandler;
    }

    it('does not call the hook when trigger.before is unset', async () => {
      const tick = setupTickHandler(makeTrigger());
      await tick();

      expect(beforeHookService.run).not.toHaveBeenCalled();
      expect(executeRunUseCase.execute).toHaveBeenCalled();
    });

    it('runs the hook before executing when trigger.before is set', async () => {
      const tick = setupTickHandler(
        makeTrigger({
          name: 'meeting-prep',
          before: '/scripts/check.sh',
          prompt: 'Prepare for meeting',
        }),
      );
      beforeHookService.run.mockResolvedValue({
        proceed: true,
        output: 'standup at 10am',
      });

      await tick();

      expect(beforeHookService.run).toHaveBeenCalledWith(
        '/scripts/check.sh',
        'cron trigger "meeting-prep"',
      );
      expect(executeRunUseCase.execute).toHaveBeenCalled();
    });

    it('substitutes {{before_output}} in the prompt with the hook stdout', async () => {
      const tick = setupTickHandler(
        makeTrigger({
          name: 'meeting-prep',
          before: '/scripts/check.sh',
          prompt: 'Prepare for: {{before_output}}',
        }),
      );
      beforeHookService.run.mockResolvedValue({
        proceed: true,
        output: 'standup at 10am',
      });

      await tick();

      expect(executeRunUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Prepare for: standup at 10am',
        }),
      );
    });

    it('substitutes {{before_output}} with empty string when hook output is empty', async () => {
      const tick = setupTickHandler(
        makeTrigger({
          before: '/scripts/check.sh',
          prompt: 'Info: {{before_output}} end',
        }),
      );
      beforeHookService.run.mockResolvedValue({ proceed: true, output: '' });

      await tick();

      expect(executeRunUseCase.execute).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: 'Info:  end' }),
      );
    });

    it('skips the run when the hook returns proceed: false', async () => {
      const tick = setupTickHandler(
        makeTrigger({
          name: 'meeting-prep',
          before: '/scripts/check.sh',
          prompt: 'Prepare',
        }),
      );
      beforeHookService.run.mockResolvedValue({ proceed: false, output: '' });

      await tick();

      expect(beforeHookService.run).toHaveBeenCalled();
      expect(executeRunUseCase.execute).not.toHaveBeenCalled();
    });
  });
});
