/* eslint-disable sonarjs/publicly-writable-directories */
/* eslint-disable security/detect-non-literal-fs-filename */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ensureDirectoryExists,
  expandHomeDir,
  normalizeCwd,
} from './cwd-path.js';

describe('cwd-path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('expands ~/', () => {
    expect(expandHomeDir('~/dev/my-repo')).toBe(
      path.join(os.homedir(), 'dev/my-repo'),
    );
  });

  it('normalizes an absolute cwd', () => {
    expect(normalizeCwd('/tmp/example/../repo')).toBe('/tmp/repo');
  });

  it('rejects relative cwd values', () => {
    expect(() => normalizeCwd('relative/path')).toThrow(BadRequestException);
  });

  it('verifies directory existence', () => {
    expect(ensureDirectoryExists(tmpDir)).toBe(tmpDir);
  });

  it('rejects missing directories', () => {
    expect(() => ensureDirectoryExists(path.join(tmpDir, 'missing'))).toThrow(
      NotFoundException,
    );
  });

  it('rejects file paths', () => {
    const filePath = path.join(tmpDir, 'file.txt');
    fs.writeFileSync(filePath, 'hello');

    expect(() => ensureDirectoryExists(filePath)).toThrow(BadRequestException);
  });
});
