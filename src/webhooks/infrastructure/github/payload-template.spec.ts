import {
  getNestedValue,
  interpolatePayloadTemplate,
} from './payload-template.js';

describe('getNestedValue', () => {
  it('should resolve a top-level key', () => {
    expect(getNestedValue({ action: 'submitted' }, 'action')).toBe('submitted');
  });

  it('should resolve a nested path', () => {
    const obj = { pull_request: { number: 42, head: { ref: 'feature' } } };
    expect(getNestedValue(obj, 'pull_request.number')).toBe(42);
    expect(getNestedValue(obj, 'pull_request.head.ref')).toBe('feature');
  });

  it('should return undefined for missing paths', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, 'a.c')).toBeUndefined();
    expect(getNestedValue({ a: { b: 1 } }, 'x.y.z')).toBeUndefined();
  });

  it('should return undefined when traversing through a primitive', () => {
    expect(getNestedValue({ a: 'string' }, 'a.b')).toBeUndefined();
  });

  it('should return undefined when traversing through null', () => {
    expect(
      getNestedValue({ a: null } as Record<string, unknown>, 'a.b'),
    ).toBeUndefined();
  });
});

describe('interpolatePayloadTemplate', () => {
  const payload = {
    action: 'submitted',
    repository: { full_name: 'org/repo', name: 'repo' },
    pull_request: {
      number: 123,
      html_url: 'https://github.com/org/repo/pull/123',
      head: { ref: 'feat-branch' },
    },
    review: {
      user: { login: 'reviewer' },
      state: 'changes_requested',
      body: 'Fix the tests',
    },
  };

  it('should interpolate top-level values', () => {
    expect(interpolatePayloadTemplate('action: {{action}}', payload)).toBe(
      'action: submitted',
    );
  });

  it('should interpolate nested values', () => {
    const template = 'PR #{{pull_request.number}} in {{repository.full_name}}';
    expect(interpolatePayloadTemplate(template, payload)).toBe(
      'PR #123 in org/repo',
    );
  });

  it('should interpolate deeply nested values', () => {
    expect(
      interpolatePayloadTemplate('Branch: {{pull_request.head.ref}}', payload),
    ).toBe('Branch: feat-branch');
  });

  it('should leave unknown paths as-is', () => {
    expect(interpolatePayloadTemplate('{{unknown.path}}', payload)).toBe(
      '{{unknown.path}}',
    );
  });

  it('should leave null values as-is', () => {
    const p = { val: null } as unknown as Record<string, unknown>;
    expect(interpolatePayloadTemplate('{{val}}', p)).toBe('{{val}}');
  });

  it('should handle a multi-line prompt template', () => {
    const template = [
      'Address review on PR #{{pull_request.number}} in {{repository.full_name}}.',
      'Reviewer: {{review.user.login}}',
      'State: {{review.state}}',
      'Body: {{review.body}}',
      'URL: {{pull_request.html_url}}',
    ].join('\n');

    const result = interpolatePayloadTemplate(template, payload);
    expect(result).toContain('PR #123 in org/repo');
    expect(result).toContain('Reviewer: reviewer');
    expect(result).toContain('State: changes_requested');
    expect(result).toContain('Body: Fix the tests');
    expect(result).toContain('URL: https://github.com/org/repo/pull/123');
  });
});
