import { BadRequestException, NotFoundException } from '@nestjs/common';
import { existsSync, statSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function expandHomeDir(input: string): string {
  if (input === '~') {
    return os.homedir();
  }

  if (input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function normalizeCwd(input: string, label = 'cwd'): string {
  const expanded = expandHomeDir(input);
  if (!path.isAbsolute(expanded)) {
    throw new BadRequestException(
      `${label} must be an absolute path or start with "~/"`,
    );
  }

  return path.normalize(expanded);
}

export function ensureDirectoryExists(input: string, label = 'cwd'): string {
  const cwd = normalizeCwd(input, label);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- cwd is validated path input
  if (!existsSync(cwd)) {
    throw new NotFoundException(`${label} does not exist: ${cwd}`);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- cwd is validated path input
  if (!statSync(cwd).isDirectory()) {
    throw new BadRequestException(`${label} is not a directory: ${cwd}`);
  }

  return cwd;
}
