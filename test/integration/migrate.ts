import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

function extractUpSql(content: string): string {
  const upMarker = '-- migrate:up';
  const downMarker = '-- migrate:down';

  if (!content.includes(upMarker)) {
    return content;
  }

  const upIndex = content.indexOf(upMarker) + upMarker.length;
  const downIndex = content.indexOf(downMarker);
  return content.slice(upIndex, downIndex === -1 ? undefined : downIndex).trim();
}

export async function applyMigrations(pool: pg.Pool): Promise<void> {
  const migrationsDir = path.resolve(__dirname, '../../src/database/migrations');
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = extractUpSql(
      readFileSync(path.join(migrationsDir, file), 'utf-8'),
    );
    if (!sql) continue;
    await pool.query(sql);
  }
}
