import { evaluateFilter, matchesFilters } from './github-webhook-filter.js';
import type { WebhookFilter } from '../triggers/trigger-config.interface.js';

describe('evaluateFilter', () => {
  const body = {
    action: 'submitted',
    repository: { full_name: 'org/repo' },
    review: { state: 'changes_requested', user: { login: 'alice' } },
    pull_request: { title: 'feat: add widget', draft: false },
  };

  describe('equals', () => {
    it('should match when value equals', () => {
      const filter: WebhookFilter = { field: 'action', equals: 'submitted' };
      expect(evaluateFilter(body, filter)).toBe(true);
    });

    it('should not match when value differs', () => {
      const filter: WebhookFilter = { field: 'action', equals: 'opened' };
      expect(evaluateFilter(body, filter)).toBe(false);
    });

    it('should work with nested fields', () => {
      const filter: WebhookFilter = {
        field: 'repository.full_name',
        equals: 'org/repo',
      };
      expect(evaluateFilter(body, filter)).toBe(true);
    });
  });

  describe('contains', () => {
    it('should match when value contains substring', () => {
      const filter: WebhookFilter = {
        field: 'pull_request.title',
        contains: 'widget',
      };
      expect(evaluateFilter(body, filter)).toBe(true);
    });

    it('should not match when substring is absent', () => {
      const filter: WebhookFilter = {
        field: 'pull_request.title',
        contains: 'bugfix',
      };
      expect(evaluateFilter(body, filter)).toBe(false);
    });

    it('should not match on non-string values', () => {
      const filter: WebhookFilter = {
        field: 'pull_request.draft',
        contains: 'false',
      };
      expect(evaluateFilter(body, filter)).toBe(false);
    });
  });

  describe('in', () => {
    it('should match when value is in the list', () => {
      const filter: WebhookFilter = {
        field: 'review.state',
        in: ['changes_requested', 'commented'],
      };
      expect(evaluateFilter(body, filter)).toBe(true);
    });

    it('should not match when value is not in the list', () => {
      const filter: WebhookFilter = {
        field: 'review.state',
        in: ['approved'],
      };
      expect(evaluateFilter(body, filter)).toBe(false);
    });
  });

  describe('pattern', () => {
    it('should match when regex matches', () => {
      const filter: WebhookFilter = {
        field: 'pull_request.title',
        pattern: '^feat:',
      };
      expect(evaluateFilter(body, filter)).toBe(true);
    });

    it('should not match when regex does not match', () => {
      const filter: WebhookFilter = {
        field: 'pull_request.title',
        pattern: '^fix:',
      };
      expect(evaluateFilter(body, filter)).toBe(false);
    });
  });

  it('should return true when no condition is set', () => {
    const filter: WebhookFilter = { field: 'action' };
    expect(evaluateFilter(body, filter)).toBe(true);
  });
});

describe('matchesFilters', () => {
  const body = {
    action: 'submitted',
    review: { state: 'changes_requested' },
    repository: { full_name: 'org/repo' },
  };

  it('should return true when filters is undefined', () => {
    expect(matchesFilters(body)).toBe(true);
  });

  it('should return true when filters is empty', () => {
    expect(matchesFilters(body, [])).toBe(true);
  });

  it('should return true when all filters pass', () => {
    const filters: WebhookFilter[] = [
      { field: 'action', equals: 'submitted' },
      { field: 'review.state', in: ['changes_requested', 'commented'] },
    ];
    expect(matchesFilters(body, filters)).toBe(true);
  });

  it('should return false when any filter fails (AND logic)', () => {
    const filters: WebhookFilter[] = [
      { field: 'action', equals: 'submitted' },
      { field: 'repository.full_name', equals: 'other/repo' },
    ];
    expect(matchesFilters(body, filters)).toBe(false);
  });
});
