import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

const BATCH_DELAY_MS = 500;

export interface BatchContents {
  texts: string[];
  imagePaths: string[];
  filePaths: string[];
  voiceTranscripts: string[];
}

export interface BatchKey {
  botName: string;
  chatId: string;
  messageThreadId?: number;
}

export interface BatchFlushContext {
  botName: string;
  chatId: string;
  userId: string;
  messageThreadId?: number;
  replyToMessageId?: number;
}

export type BatchFlushHandler = (
  contents: BatchContents,
  context: BatchFlushContext,
) => Promise<void>;

interface PendingBatch {
  key: string;
  contents: BatchContents;
  context: BatchFlushContext;
  timer: NodeJS.Timeout;
}

@Injectable()
export class TelegramBatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(TelegramBatcherService.name);
  private readonly pending = new Map<string, PendingBatch>();
  private flushHandler?: BatchFlushHandler;

  setFlushHandler(handler: BatchFlushHandler): void {
    this.flushHandler = handler;
  }

  onModuleDestroy(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
    }
    this.pending.clear();
  }

  push(params: {
    key: BatchKey;
    context: BatchFlushContext;
    text?: string;
    imagePath?: string;
    filePath?: string;
    voiceTranscript?: string;
  }): void {
    const keyStr = this.serializeKey(params.key);
    const existing = this.pending.get(keyStr);

    if (existing) {
      if (params.text) existing.contents.texts.push(params.text);
      if (params.imagePath) existing.contents.imagePaths.push(params.imagePath);
      if (params.filePath) existing.contents.filePaths.push(params.filePath);
      if (params.voiceTranscript)
        existing.contents.voiceTranscripts.push(params.voiceTranscript);
      existing.context = params.context;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(
        () => void this.flush(keyStr),
        BATCH_DELAY_MS,
      );
      return;
    }

    const contents: BatchContents = {
      texts: params.text ? [params.text] : [],
      imagePaths: params.imagePath ? [params.imagePath] : [],
      filePaths: params.filePath ? [params.filePath] : [],
      voiceTranscripts: params.voiceTranscript ? [params.voiceTranscript] : [],
    };

    const pending: PendingBatch = {
      key: keyStr,
      contents,
      context: params.context,
      timer: setTimeout(() => void this.flush(keyStr), BATCH_DELAY_MS),
    };
    this.pending.set(keyStr, pending);
  }

  private async flush(keyStr: string): Promise<void> {
    const pending = this.pending.get(keyStr);
    if (!pending) return;
    this.pending.delete(keyStr);

    if (!this.flushHandler) {
      this.logger.warn('No flush handler registered; dropping batch', {
        key: keyStr,
      });
      return;
    }

    try {
      await this.flushHandler(pending.contents, pending.context);
    } catch (error) {
      this.logger.error('Flush handler threw', {
        error: error as Error,
        key: keyStr,
      });
    }
  }

  private serializeKey(key: BatchKey): string {
    return `${key.botName}:${key.chatId}:${key.messageThreadId ?? 'main'}`;
  }
}
