import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Bot, type Context } from 'grammy';
import { TriggerConfigService } from '../config/trigger-config.service.js';
import type { TelegramTrigger } from '../config/trigger-config.interface.js';
import { TelegramIngestService } from './telegram-ingest.service.js';
import { TelegramMediaService } from './telegram-media.service.js';
import { VoxtralTranscriptionService } from './voxtral-transcription.service.js';
import {
  TelegramBatcherService,
  type BatchContents,
  type BatchFlushContext,
} from './telegram-batcher.service.js';

const TELEGRAM_SYSTEM_PROMPT = `
You are responding via Telegram messenger. Format your responses accordingly:

- Keep responses concise — mobile screens are small
- NEVER use markdown tables — they render poorly. Use bullet lists or simple text instead
- Use short paragraphs with blank lines between them
- Code blocks are fine but keep them brief when possible
- Bold and italic formatting works, but use sparingly
`.trim();

interface RunningBot {
  botName: string;
  bot: Bot;
}

@Injectable()
export class TelegramPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramPollerService.name);
  private readonly runningBots: RunningBot[] = [];

  constructor(
    private readonly triggerConfigService: TriggerConfigService,
    private readonly ingestService: TelegramIngestService,
    private readonly mediaService: TelegramMediaService,
    private readonly transcriptionService: VoxtralTranscriptionService,
    private readonly batcherService: TelegramBatcherService,
  ) {}

  onModuleInit(): void {
    this.batcherService.setFlushHandler((contents, context) =>
      this.flushBatch(contents, context),
    );

    const triggers = this.triggerConfigService.getTelegramTriggers();
    if (triggers.length === 0) {
      this.logger.log('No Telegram triggers configured; poller idle');
      return;
    }

    const byBotName = new Map<string, TelegramTrigger[]>();
    for (const trigger of triggers) {
      const existing = byBotName.get(trigger.bot_name) ?? [];
      existing.push(trigger);
      byBotName.set(trigger.bot_name, existing);
    }

    for (const [botName, group] of byBotName) {
      const tokens = new Set(group.map((t) => t.bot_token));
      if (tokens.size > 1) {
        this.logger.error(
          `Telegram bot "${botName}" has inconsistent bot_token across triggers; skipping`,
        );
        continue;
      }
      const token = [...tokens][0];
      try {
        const bot = this.createBot(botName, token, group);
        this.runningBots.push({ botName, bot });
      } catch (error) {
        this.logger.error(`Failed to initialize Telegram bot "${botName}"`, {
          error: error as Error,
        });
      }
    }

    for (const { botName, bot } of this.runningBots) {
      this.logger.log(`Starting Telegram long-polling for bot "${botName}"`);
      void bot
        .start({
          onStart: () => {
            this.logger.log(`Telegram bot "${botName}" is running`);
          },
        })
        .catch((error: unknown) => {
          this.logger.error(`Telegram bot "${botName}" stopped with error`, {
            error: error as Error,
          });
        });
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const { botName, bot } of this.runningBots) {
      try {
        await bot.stop();
        this.logger.log(`Stopped Telegram bot "${botName}"`);
      } catch (error) {
        this.logger.error(`Failed to stop Telegram bot "${botName}"`, {
          error: error as Error,
        });
      }
    }
    this.runningBots.length = 0;
  }

  private createBot(
    botName: string,
    botToken: string,
    triggers: TelegramTrigger[],
  ): Bot {
    const allowedUserIds = new Set(triggers.map((t) => t.user_id));
    const bot = new Bot(botToken);

    bot.use(async (ctx, next) => {
      const userId = ctx.from?.id;
      if (userId === undefined || !allowedUserIds.has(String(userId))) {
        this.logger.warn('Rejected Telegram message from unauthorized user', {
          botName,
          userId,
        });
        return;
      }
      await next();
    });

    bot.on('message:text', (ctx) => {
      const context = this.extractContext(botName, ctx);
      if (!context) return;
      this.batcherService.push({
        key: {
          botName,
          chatId: context.chatId,
          messageThreadId: context.messageThreadId,
        },
        context,
        text: ctx.message.text,
      });
    });

    bot.on('message:photo', async (ctx) => {
      const context = this.extractContext(botName, ctx);
      if (!context) return;
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      const caption = ctx.message.caption;
      try {
        const localPath = await this.mediaService.download({
          botToken,
          fileId: largest.file_id,
          kind: 'image',
          extensionFallback: '.jpg',
        });
        this.batcherService.push({
          key: {
            botName,
            chatId: context.chatId,
            messageThreadId: context.messageThreadId,
          },
          context,
          imagePath: localPath,
          text: caption,
        });
      } catch (error) {
        this.logger.error('Failed to download Telegram photo', {
          error: error as Error,
          botName,
        });
        await ctx.reply('Failed to download image.').catch(() => {});
      }
    });

    bot.on('message:document', async (ctx) => {
      const context = this.extractContext(botName, ctx);
      if (!context) return;
      const doc = ctx.message.document;
      const caption = ctx.message.caption;
      const mimeType = doc.mime_type ?? '';
      const isImage = mimeType.startsWith('image/');
      try {
        const localPath = await this.mediaService.download({
          botToken,
          fileId: doc.file_id,
          kind: isImage ? 'image' : 'file',
          originalFileName: doc.file_name,
        });
        this.batcherService.push({
          key: {
            botName,
            chatId: context.chatId,
            messageThreadId: context.messageThreadId,
          },
          context,
          imagePath: isImage ? localPath : undefined,
          filePath: isImage ? undefined : localPath,
          text: caption,
        });
      } catch (error) {
        this.logger.error('Failed to download Telegram document', {
          error: error as Error,
          botName,
        });
        await ctx.reply('Failed to download document.').catch(() => {});
      }
    });

    bot.on('message:voice', async (ctx) => {
      const context = this.extractContext(botName, ctx);
      if (!context) return;
      await this.handleAudioLike(
        botName,
        botToken,
        ctx,
        context,
        ctx.message.voice.file_id,
        '.oga',
      );
    });

    bot.on('message:audio', async (ctx) => {
      const context = this.extractContext(botName, ctx);
      if (!context) return;
      await this.handleAudioLike(
        botName,
        botToken,
        ctx,
        context,
        ctx.message.audio.file_id,
        '.mp3',
      );
    });

    return bot;
  }

  private async handleAudioLike(
    botName: string,
    botToken: string,
    ctx: Context,
    context: BatchFlushContext,
    fileId: string,
    extensionFallback: string,
  ): Promise<void> {
    if (!this.transcriptionService.isAvailable()) {
      await ctx
        .reply('Voice transcription disabled (MISTRAL_API_KEY not set).')
        .catch(() => {});
      return;
    }

    let localPath: string | undefined;
    try {
      localPath = await this.mediaService.download({
        botToken,
        fileId,
        kind: 'voice',
        extensionFallback,
      });
      const transcript = await this.transcriptionService.transcribe(localPath);
      this.mediaService.deleteSilently(localPath);

      if (!transcript.trim()) {
        await ctx
          .reply(
            'Could not transcribe voice message — it was empty or unclear.',
          )
          .catch(() => {});
        return;
      }

      await ctx.reply(`🎤 ${transcript}`).catch(() => {});
      this.batcherService.push({
        key: {
          botName,
          chatId: context.chatId,
          messageThreadId: context.messageThreadId,
        },
        context,
        voiceTranscript: transcript,
        text: ctx.message?.caption,
      });
    } catch (error) {
      this.logger.error('Failed to handle Telegram audio', {
        error: error as Error,
        botName,
      });
      if (localPath) this.mediaService.deleteSilently(localPath);
      await ctx.reply('Failed to transcribe audio.').catch(() => {});
    }
  }

  private extractContext(
    botName: string,
    ctx: Context,
  ): BatchFlushContext | undefined {
    const chat = ctx.chat;
    const from = ctx.from;
    const message = ctx.message;
    if (!chat || !from || !message) return undefined;
    return {
      botName,
      chatId: String(chat.id),
      userId: String(from.id),
      messageThreadId: message.message_thread_id,
      replyToMessageId: message.message_id,
    };
  }

  private async flushBatch(
    contents: BatchContents,
    context: BatchFlushContext,
  ): Promise<void> {
    const prompt = this.composePrompt(contents);
    if (!prompt) return;

    await this.ingestService.ingestMessage({
      botName: context.botName,
      chatId: context.chatId,
      userId: context.userId,
      messageThreadId: context.messageThreadId,
      replyToMessageId: context.replyToMessageId,
      text: prompt,
      extraAppendSystemPrompt: TELEGRAM_SYSTEM_PROMPT,
    });
  }

  private composePrompt(contents: BatchContents): string {
    const userText = contents.texts.join('\n\n').trim();
    const transcripts = contents.voiceTranscripts.map(
      (t) => `[Voice message transcription]: ${t}`,
    );
    const attachmentRefs: string[] = [
      ...contents.imagePaths.map((p) => `[Image: ${p}]`),
      ...contents.filePaths.map((p) => `[File: ${p}]`),
      ...transcripts,
    ];

    const sections: string[] = [];
    if (attachmentRefs.length > 0) {
      sections.push(attachmentRefs.join('\n'));
    }

    if (userText) {
      sections.push(userText);
    } else if (
      contents.imagePaths.length > 0 &&
      contents.filePaths.length === 0 &&
      transcripts.length === 0
    ) {
      sections.push('Please look at this image and describe what you see.');
    } else if (
      contents.filePaths.length > 0 &&
      contents.imagePaths.length === 0 &&
      transcripts.length === 0
    ) {
      sections.push('Please examine the attached file(s).');
    }

    return sections.join('\n\n');
  }
}
