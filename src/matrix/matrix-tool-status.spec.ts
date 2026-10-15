import { formatToolStatus } from './matrix-tool-status.js';

describe('formatToolStatus', () => {
  it('shows the most telling argument as code', () => {
    expect(formatToolStatus('bash', { command: 'ls -la', timeout: 20 })).toBe(
      '🔧 bash `ls -la`',
    );
    expect(
      formatToolStatus('read', {
        offset: 1,
        path: '/home/daniel/org/daily.org',
      }),
    ).toBe('🔧 read `~/org/daily.org`');
  });

  it('falls back to the first string argument, or just the name', () => {
    expect(formatToolStatus('custom', { n: 1, label: 'x' })).toBe(
      '🔧 custom `x`',
    );
    expect(formatToolStatus('custom', { n: 1 })).toBe('🔧 custom');
    expect(formatToolStatus('custom', undefined)).toBe('🔧 custom');
  });

  it('keeps it to one short line without breaking the code span', () => {
    expect(
      formatToolStatus('bash', { command: "cat <<'EOF'\nsecret\nEOF" }),
    ).toBe("🔧 bash `cat <<'EOF' …`");
    expect(formatToolStatus('bash', { command: 'echo `date`' })).toBe(
      "🔧 bash `echo 'date'`",
    );
    const status = formatToolStatus('bash', { command: 'x'.repeat(200) });
    expect(status).toBe(`🔧 bash \`${'x'.repeat(79)}…\``);
  });
});
