import { describe, expect, it } from 'vitest';
import { validateToolCall } from './validateToolCall';

describe('validateToolCall', () => {
  const canExecute = ['navigate', 'addToCart', 'clearCart'];

  it('returns true for an allowed tool name', () => {
    expect(validateToolCall('navigate', canExecute)).toBe(true);
  });

  it('returns false for a disallowed tool name', () => {
    expect(validateToolCall('deleteAccount', canExecute)).toBe(false);
  });

  it('returns false when canExecute is empty', () => {
    expect(validateToolCall('navigate', [])).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(validateToolCall('Navigate', canExecute)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateToolCall('', canExecute)).toBe(false);
  });
});
