import { describe, expect, it } from 'vitest';
import { filterState } from './filterState';

describe('filterState', () => {
  it('returns only keys listed in canAccess', () => {
    const state = { user: 'Alice', cart: [1, 2], secret: 'hidden' };
    const result = filterState(state, ['user', 'cart']);
    expect(result).toEqual({ user: 'Alice', cart: [1, 2] });
    expect('secret' in result).toBe(false);
  });

  it('returns empty object when canAccess is empty', () => {
    const state = { user: 'Alice', cart: [] };
    expect(filterState(state, [])).toEqual({});
  });

  it('ignores canAccess keys not present in state', () => {
    const state = { user: 'Alice' };
    const result = filterState(state, ['user', 'nonexistent']);
    expect(result).toEqual({ user: 'Alice' });
  });

  it('returns empty object when state is empty', () => {
    expect(filterState({}, ['user'])).toEqual({});
  });

  it('preserves undefined and null values', () => {
    const state = { a: undefined, b: null, c: 0 };
    const result = filterState(state, ['a', 'b', 'c']);
    expect(result).toEqual({ a: undefined, b: null, c: 0 });
  });
});
