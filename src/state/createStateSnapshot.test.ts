import { describe, it, expect, vi } from 'vitest';
import { createStateSnapshot } from './createStateSnapshot';

describe('createStateSnapshot', () => {
  it('filters state to only allowed keys', () => {
    const state = { user: 'Alice', cart: [1, 2], secret: 'hidden' };
    const result = createStateSnapshot(state, ['user', 'cart']);

    expect(result).toEqual({ user: 'Alice', cart: [1, 2] });
    expect(result).not.toHaveProperty('secret');
  });

  it('returns empty object when canAccess is empty', () => {
    const state = { user: 'Alice', cart: [1, 2] };
    const result = createStateSnapshot(state, []);

    expect(result).toEqual({});
  });

  it('ignores canAccess keys that do not exist in state', () => {
    const state = { user: 'Alice' };
    const result = createStateSnapshot(state, ['user', 'nonexistent']);

    expect(result).toEqual({ user: 'Alice' });
  });

  it('works with state as a getter function', () => {
    const state = () => ({ user: 'Bob', products: [1, 2, 3] });
    const result = createStateSnapshot(state, ['products']);

    expect(result).toEqual({ products: [1, 2, 3] });
  });

  it('strips function values from state', () => {
    const state = { name: 'Alice', callback: () => {} };
    const result = createStateSnapshot(state, ['name', 'callback']);

    expect(result).toEqual({ name: 'Alice' });
    expect(result).not.toHaveProperty('callback');
  });

  it('strips symbol values from state', () => {
    const state = { name: 'Alice', sym: Symbol('test') };
    const result = createStateSnapshot(state, ['name', 'sym']);

    expect(result).toEqual({ name: 'Alice' });
  });

  it('strips values with circular references', () => {
    const circular: Record<string, unknown> = { name: 'test' };
    circular.self = circular;

    const state = { good: 'value', bad: circular };
    const result = createStateSnapshot(state, ['good', 'bad']);

    expect(result).toEqual({ good: 'value' });
  });

  it('warns in debug mode when non-serializable values are stripped', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = { name: 'Alice', fn: () => {} };
    createStateSnapshot(state, ['name', 'fn'], true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Non-serializable value stripped'),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when debug is false', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const state = { name: 'Alice', fn: () => {} };
    createStateSnapshot(state, ['name', 'fn'], false);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('preserves null and undefined values', () => {
    const state = { a: null, b: undefined, c: 'yes' };
    const result = createStateSnapshot(state, ['a', 'b', 'c']);

    expect(result).toEqual({ a: null, b: undefined, c: 'yes' });
  });

  it('preserves nested objects and arrays', () => {
    const state = {
      user: { name: 'Alice', prefs: { theme: 'dark' } },
      items: [{ id: 1 }, { id: 2 }],
    };
    const result = createStateSnapshot(state, ['user', 'items']);

    expect(result).toEqual({
      user: { name: 'Alice', prefs: { theme: 'dark' } },
      items: [{ id: 1 }, { id: 2 }],
    });
  });

  it('propagates errors from state function', () => {
    const state = () => {
      throw new Error('store unavailable');
    };

    expect(() => createStateSnapshot(state, ['anything'])).toThrowError(
      'store unavailable',
    );
  });
});
