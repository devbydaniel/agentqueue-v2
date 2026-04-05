import { interpolateTemplate } from './interpolate-template.js';

describe('interpolateTemplate', () => {
  it('should replace known {{key}} variables', () => {
    const result = interpolateTemplate(
      'Issue: {{issueId}}, action: {{action}}',
      {
        issueId: 'ABC-123',
        action: 'created',
      },
    );
    expect(result).toBe('Issue: ABC-123, action: created');
  });

  it('should leave unknown keys as-is', () => {
    const result = interpolateTemplate('Hello {{name}}, unknown {{missing}}', {
      name: 'World',
    });
    expect(result).toBe('Hello World, unknown {{missing}}');
  });

  it('should leave keys with undefined values as-is', () => {
    const result = interpolateTemplate('Issue: {{issueId}}', {
      issueId: undefined,
    });
    expect(result).toBe('Issue: {{issueId}}');
  });

  it('should return the template unchanged when no patterns exist', () => {
    const result = interpolateTemplate('No variables here', { key: 'val' });
    expect(result).toBe('No variables here');
  });

  it('should handle empty template', () => {
    const result = interpolateTemplate('', { key: 'val' });
    expect(result).toBe('');
  });

  it('should handle multiple occurrences of the same key', () => {
    const result = interpolateTemplate('{{x}} and {{x}}', { x: 'hi' });
    expect(result).toBe('hi and hi');
  });
});
