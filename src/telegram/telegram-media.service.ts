import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';

// eslint-disable-next-line sonarjs/publicly-writable-directories -- per-user tmp dir under /tmp is the intended pattern on single-user hosts
const TMP_ROOT = '/tmp/agentqueue-telegram';
export const TMP_IMAGE_DIR = path.join(TMP_ROOT, 'images');
export const TMP_FILE_DIR = path.join(TMP_ROOT, 'files');
export const TMP_VOICE_DIR = path.join(TMP_ROOT, 'voice');

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const FILE_TTL_MS = 60 * 60 * 1000;

export type TelegramMediaKind = 'image' | 'file' | 'voice';

interface DownloadParams {
  botToken: string;
  fileId: string;
  kind: TelegramMediaKind;
  /** Original filename (from document). Used to derive the extension. */
  originalFileName?: string;
  /** Extension fallback (e.g. `.oga`, `.jpg`) when none can be inferred. */
  extensionFallback?: string;
}

interface TelegramGetFileResponse {
  ok: boolean;
  result?: { file_path?: string };
  description?: string;
}

@Injectable()
export class TelegramMediaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramMediaService.name);
  private cleanupTimer?: NodeJS.Timeout;

  onModuleInit(): void {
    for (const dir of [TMP_IMAGE_DIR, TMP_FILE_DIR, TMP_VOICE_DIR]) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a constant within this module
      fs.mkdirSync(dir, { recursive: true });
    }
    this.cleanupTimer = setInterval(
      () => this.cleanupOldFiles(),
      CLEANUP_INTERVAL_MS,
    );
    // Run once at startup so leftovers from a previous process are cleared
    this.cleanupOldFiles();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  async download(params: DownloadParams): Promise<string> {
    const getFileUrl = `https://api.telegram.org/bot${params.botToken}/getFile?file_id=${encodeURIComponent(params.fileId)}`;
    const metaResponse = await fetch(getFileUrl);
    if (!metaResponse.ok) {
      const body = await metaResponse.text();
      throw new Error(
        `Telegram getFile failed (${metaResponse.status}): ${body}`,
      );
    }

    const meta = (await metaResponse.json()) as TelegramGetFileResponse;
    if (!meta.ok || !meta.result?.file_path) {
      throw new Error(
        `Telegram getFile returned no file_path: ${meta.description ?? 'unknown error'}`,
      );
    }

    const remoteFilePath = meta.result.file_path;
    const downloadUrl = `https://api.telegram.org/file/bot${params.botToken}/${remoteFilePath}`;
    const ext =
      path.extname(params.originalFileName ?? '') ||
      path.extname(remoteFilePath) ||
      (params.extensionFallback ?? '');
    const targetDir = this.dirFor(params.kind);
    const localPath = path.join(
      targetDir,
      `${Date.now()}-${params.fileId}${ext}`,
    );

    await this.downloadFile(downloadUrl, localPath);
    this.logger.debug('Downloaded Telegram media', {
      kind: params.kind,
      localPath,
    });
    return localPath;
  }

  deleteSilently(filePath: string): void {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is confined to our tmp dirs
    fs.unlink(filePath, () => {});
  }

  private dirFor(kind: TelegramMediaKind): string {
    switch (kind) {
      case 'image':
        return TMP_IMAGE_DIR;
      case 'file':
        return TMP_FILE_DIR;
      case 'voice':
        return TMP_VOICE_DIR;
    }
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath is built from our tmp dir constants
      const file = fs.createWriteStream(destPath);
      https
        .get(url, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            if (redirectUrl) {
              file.close();
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath is built from our tmp dir constants
              fs.unlink(destPath, () => {});
              this.downloadFile(redirectUrl, destPath)
                .then(resolve)
                .catch(reject);
              return;
            }
          }
          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          // eslint-disable-next-line security/detect-non-literal-fs-filename -- destPath is built from our tmp dir constants
          fs.unlink(destPath, () => {});
          reject(err);
        });
    });
  }

  private cleanupOldFiles(): void {
    const now = Date.now();
    for (const dir of [TMP_IMAGE_DIR, TMP_FILE_DIR, TMP_VOICE_DIR]) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- dir is a constant within this module
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is built from constant dirs
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > FILE_TTL_MS) {
              // eslint-disable-next-line security/detect-non-literal-fs-filename -- filePath is built from constant dirs
              fs.unlinkSync(filePath);
            }
          } catch {
            // ignore per-file errors
          }
        }
      } catch {
        // ignore per-dir errors
      }
    }
  }
}
