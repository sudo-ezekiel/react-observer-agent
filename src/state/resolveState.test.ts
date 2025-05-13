import { describe, it, expect } from 'vitest';
import { resolveState } from './resolveState';

describe('resolveState', () => {
  it('returns the object directly when state is an object', () => {
    const state = { user: 'Alice', count: 42 };
    expect(resolveState(state)).toBe(state);
  });

  it('calls the function and returns its result when state is a function', () => {
    const state = () => ({ user: 'Bob', count: 10 });
    expect(resolveState(state)).toEqual({ user: 'Bob', count: 10 });
  });

  it('calls the function each time', () => {
    let counter = 0;
    const state = () => ({ count: ++counter });

    expect(resolveState(state)).toEqual({ count: 1 });
    expect(resolveState(state)).toEqual({ count: 2 });
  });

  it('propagates errors from state function', () => {
    const state = () => {
      throw new Error('store not ready');
    };

    expect(() => resolveState(state)).toThrowError('store not ready');
  });
});
