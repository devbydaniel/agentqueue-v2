import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { MatrixClient } from './matrix-client.js';

// eslint-disable-next-line sonarjs/publicly-writable-directories -- per-process tmp dir, same pattern as the Telegram connector
const TMP_ROOT = '/tmp/agentqueue-matrix';
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const MAX_AGE_MS = 60 * 60 * 1000;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
};

/**
 * Downloads Matrix media into a short-lived tmp dir so the agent can read it
 * by path. Each download gets its own directory, swept after an hour.
 */
@Injectable()
export class MatrixMediaService implements OnModuleInit, OnModuleDestroy {
  private sweepTimer?: NodeJS.Timeout;

  async onModuleInit(): Promise<void> {
    await mkdir(TMP_ROOT, { recursive: true });
    await this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  async download(
    client: MatrixClient,
    mxcUrl: string,
    fileName: string | undefined,
    mimeType: string | undefined,
  ): Promise<string> {
    const media = await client.downloadMedia(mxcUrl);
    const dir = path.join(TMP_ROOT, `${Date.now()}-${mxcUrl.split('/').pop()}`);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a child of TMP_ROOT named from a timestamp and the media ID
    await mkdir(dir, { recursive: true });
    const target = path.join(
      dir,
      safeFileName(fileName, mimeType ?? media.contentType),
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- target is confined to TMP_ROOT with a sanitized basename
    await writeFile(target, media.data);
    return target;
  }

  private async sweep(): Promise<void> {
    const entries = await readdir(TMP_ROOT).catch(() => [] as string[]);
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const entry of entries) {
      const full = path.join(TMP_ROOT, entry);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- full is a direct child of TMP_ROOT
      const info = await stat(full).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) {
        await rm(full, { recursive: true, force: true });
      }
    }
  }
}

function safeFileName(
  fileName: string | undefined,
  mimeType: string | undefined,
): string {
  const base = path.basename(fileName ?? '').replace(/[^\w.-]+/g, '_');
  if (base && path.extname(base)) return base;
  const ext = (mimeType && EXTENSIONS[mimeType.split(';')[0]]) ?? '';
  return `${base || 'attachment'}${ext}`;
}
