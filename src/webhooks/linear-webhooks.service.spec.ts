import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import {
  LinearWebhooksService,
  type HandleLinearWebhookParams,
} from './linear-webhooks.service.js';
import type { LinearWebhookParserService } from './linear-webhook-parser.service.js';
import type { TriggerConfigService } from '../config/trigger-config.service.js';
import type { RunsService } from '../runs/runs.service.js';
import type { LinearTrigger } from '../config/trigger-config.interface.js';

/** Flush pending microtasks so async fire-and-forget chains complete. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('LinearWebhooksService', () => {
  let service: LinearWebhooksService;
  let triggerConfigService: jest.Mocked<
    Pick<
      TriggerConfigService,
      'getLinearTriggersByName' | 'getLinearTriggerByKey'
    >
  >;
  let parserService: jest.Mocked<
    Pick<
      LinearWebhookParserService,
      | 'verifySignature'
      | 'verifyTimestamp'
      | 'parsePayload'
      | 'createLinearClient'
    >
  >;
  let runsService: jest.Mocked<
    Pick<
      RunsService,
      'enqueue' | 'abortSession' | 'findTriggerNameByExternalSessionId'
    >
  >;
  let tmpDir: string;

  const validRawBody = Buffer.from('{"type":"AgentSession"}');
  const validSignature = 'abc123';
  const validTimestamp = String(Date.now());

  function makeTrigger(overrides?: Partial<LinearTrigger>): LinearTrigger {
    return {
      name: 'coding-agent',
      type: 'linear',
      cwd: tmpDir,
      signing_secret: 'secret',
      api_key: 'api-key',
      agent: 'claude',
      ...overrides,
    };
  }

  function makeParams(
    overrides?: Partial<HandleLinearWebhookParams>,
  ): HandleLinearWebhookParams {
    return {
      agentName: 'coding-agent',
      rawBody: validRawBody,
      signatureHeader: validSignature,
      timestampHeader: validTimestamp,
      body: { type: 'AgentSession', action: 'created' },
      ...overrides,
    };
  }

  function makeCreatedPayload(
    eventType: 'assigned' | 'mentioned' = 'assigned',
  ) {
    return {
      action: 'created' as const,
      agentSessionId: 'session-1',
      promptContext: 'Fix the bug',
      issueId: 'ISSUE-1',
      eventType,
    };
  }

  function makePromptedPayload() {
    return {
      action: 'prompted' as const,
      agentSessionId: 'session-1',
      agentActivityBody: 'Follow-up instruction',
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linear-webhooks-test-'));

    triggerConfigService = {
      getLinearTriggersByName: jest.fn().mockReturnValue([]),
      getLinearTriggerByKey: jest.fn(),
    };

    parserService = {
      verifySignature: jest.fn().mockReturnValue(true),
      verifyTimestamp: jest.fn().mockReturnValue(true),
      parsePayload: jest.fn().mockReturnValue(makeCreatedPayload()),
      createLinearClient: jest.fn().mockReturnValue({
        createAgentActivity: jest.fn(),
      }),
    };

    runsService = {
      enqueue: jest
        .fn()
        .mockResolvedValue({ runId: 'run-1', status: 'waiting' }),
      abortSession: jest.fn().mockReturnValue(true),
      findTriggerNameByExternalSessionId: jest.fn().mockResolvedValue(null),
    };

    service = new LinearWebhooksService(
      triggerConfigService as unknown as TriggerConfigService,
      parserService as unknown as LinearWebhookParserService,
      runsService as unknown as RunsService,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Basic routing ─────────────────────────────────────────────────

  describe('handleWebhook — basic routing', () => {
    it('should throw NotFoundException when no triggers match the agent name', () => {
      triggerConfigService.getLinearTriggersByName.mockReturnValue([]);

      expect(() => service.handleWebhook(makeParams())).toThrow(
        NotFoundException,
      );
    });

    it('should throw UnauthorizedException for missing signature', () => {
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        makeTrigger(),
      ]);

      expect(() =>
        service.handleWebhook(makeParams({ signatureHeader: undefined })),
      ).toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for invalid signature', () => {
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        makeTrigger(),
      ]);
      parserService.verifySignature.mockReturnValue(false);

      expect(() => service.handleWebhook(makeParams())).toThrow(
        UnauthorizedException,
      );
    });

    it('should throw UnauthorizedException for stale timestamp', () => {
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        makeTrigger(),
      ]);
      parserService.verifyTimestamp.mockReturnValue(false);

      expect(() => service.handleWebhook(makeParams())).toThrow(
        UnauthorizedException,
      );
    });
  });

  // ─── Created action ────────────────────────────────────────────────

  describe('handleWebhook — created action', () => {
    it('should enqueue a run for a single trigger (no `on` filter, catch-all)', async () => {
      const trigger = makeTrigger();
      triggerConfigService.getLinearTriggersByName.mockReturnValue([trigger]);
      parserService.parsePayload.mockReturnValue(
        makeCreatedPayload('assigned'),
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledTimes(1);
      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'linear',
          triggerName: 'coding-agent',
          agentName: 'claude',
          cwd: tmpDir,
          prompt: 'Fix the bug',
          externalSessionId: 'session-1',
        }),
      );
    });

    it('should enqueue only the assigned trigger when eventType is assigned', async () => {
      const assignedTrigger = makeTrigger({
        on: 'assigned',
        append_system_prompt: 'assigned-prompt',
      });
      const mentionedTrigger = makeTrigger({
        on: 'mentioned',
        append_system_prompt: 'mentioned-prompt',
      });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        assignedTrigger,
        mentionedTrigger,
      ]);
      parserService.parsePayload.mockReturnValue(
        makeCreatedPayload('assigned'),
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledTimes(1);
      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerName: 'coding-agent:assigned',
        }),
      );
    });

    it('should enqueue only the mentioned trigger when eventType is mentioned', async () => {
      const assignedTrigger = makeTrigger({ on: 'assigned' });
      const mentionedTrigger = makeTrigger({ on: 'mentioned' });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        assignedTrigger,
        mentionedTrigger,
      ]);
      parserService.parsePayload.mockReturnValue(
        makeCreatedPayload('mentioned'),
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledTimes(1);
      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerName: 'coding-agent:mentioned',
        }),
      );
    });

    it('should log and return when no triggers match the event type', async () => {
      const assignedTrigger = makeTrigger({ on: 'assigned' });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        assignedTrigger,
      ]);
      parserService.parsePayload.mockReturnValue(
        makeCreatedPayload('mentioned'),
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).not.toHaveBeenCalled();
    });

    it('should store composite trigger key (name:on) as triggerName on the enqueued run', async () => {
      const trigger = makeTrigger({ on: 'assigned' });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([trigger]);
      parserService.parsePayload.mockReturnValue(
        makeCreatedPayload('assigned'),
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerName: 'coding-agent:assigned',
        }),
      );
    });
  });

  // ─── Prompted action ───────────────────────────────────────────────

  describe('handleWebhook — prompted action', () => {
    it('should resolve the original trigger by externalSessionId and enqueue with correct config', async () => {
      const assignedTrigger = makeTrigger({
        on: 'assigned',
        append_system_prompt: 'assigned-sys',
      });
      const mentionedTrigger = makeTrigger({
        on: 'mentioned',
        append_system_prompt: 'mentioned-sys',
      });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        assignedTrigger,
        mentionedTrigger,
      ]);
      parserService.parsePayload.mockReturnValue(makePromptedPayload());
      runsService.findTriggerNameByExternalSessionId.mockResolvedValue(
        'coding-agent:assigned',
      );
      triggerConfigService.getLinearTriggerByKey.mockReturnValue(
        assignedTrigger,
      );

      service.handleWebhook(makeParams());
      await flush();

      expect(
        runsService.findTriggerNameByExternalSessionId,
      ).toHaveBeenCalledWith('session-1');
      expect(triggerConfigService.getLinearTriggerByKey).toHaveBeenCalledWith(
        'coding-agent:assigned',
      );
      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerName: 'coding-agent:assigned',
          prompt: 'Follow-up instruction',
        }),
      );
    });

    it('should fall back to first trigger when original trigger not found in DB', async () => {
      const firstTrigger = makeTrigger({ on: 'assigned' });
      const secondTrigger = makeTrigger({ on: 'mentioned' });
      triggerConfigService.getLinearTriggersByName.mockReturnValue([
        firstTrigger,
        secondTrigger,
      ]);
      parserService.parsePayload.mockReturnValue(makePromptedPayload());
      runsService.findTriggerNameByExternalSessionId.mockResolvedValue(null);

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerName: 'coding-agent:assigned',
          prompt: 'Follow-up instruction',
        }),
      );
    });
  });

  // ─── Stop signal ───────────────────────────────────────────────────

  describe('handleWebhook — stop signal', () => {
    it('should abort session and emit response to Linear on stop signal', async () => {
      const trigger = makeTrigger();
      triggerConfigService.getLinearTriggersByName.mockReturnValue([trigger]);
      parserService.parsePayload.mockReturnValue({
        action: 'prompted',
        agentSessionId: 'session-1',
        signal: 'stop',
      });

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.abortSession).toHaveBeenCalledWith('session-1');
      expect(parserService.createLinearClient).toHaveBeenCalledWith('api-key');
      expect(runsService.enqueue).not.toHaveBeenCalled();
    });
  });

  // ─── Unknown action ────────────────────────────────────────────────

  describe('handleWebhook — unknown action', () => {
    it('should log warning for unhandled action (no enqueue)', async () => {
      const trigger = makeTrigger();
      triggerConfigService.getLinearTriggersByName.mockReturnValue([trigger]);
      parserService.parsePayload.mockReturnValue({
        action: 'deleted',
        agentSessionId: 'session-1',
      });

      service.handleWebhook(makeParams());
      await flush();

      expect(runsService.enqueue).not.toHaveBeenCalled();
      expect(runsService.abortSession).not.toHaveBeenCalled();
    });
  });
});
