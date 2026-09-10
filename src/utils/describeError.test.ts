import { describe, expect, it } from 'vitest';
import { describeError } from './describeError';

describe('describeError', () => {
  it('returns the message of an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('falls back to the name of an Error with an empty message', () => {
    const error = new Error('');
    error.name = 'CustomError';
    expect(describeError(error)).toBe('CustomError');
  });

  it('returns a thrown string as-is', () => {
    expect(describeError('Insufficient funds')).toBe('Insufficient funds');
  });

  it('returns the fallback for an empty string', () => {
    expect(describeError('')).toBe('Unknown error');
  });

  it('returns the string message of an object', () => {
    expect(describeError({ code: 402, message: 'Card declined' })).toBe(
      'Card declined',
    );
  });

  it('falls through to JSON when the message is an empty string', () => {
    expect(describeError({ message: '', code: 402 })).toBe(
      JSON.stringify({ message: '', code: 402 }),
    );
  });

  it('serializes a plain object with no message as JSON', () => {
    expect(describeError({ code: 402 })).toBe(JSON.stringify({ code: 402 }));
  });

  it('returns the fallback for an empty object', () => {
    expect(describeError({})).toBe('Unknown error');
  });

  it('returns the fallback for a circular object', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(describeError(circular)).toBe('Unknown error');
  });

  it('returns the fallback for null', () => {
    expect(describeError(null)).toBe('Unknown error');
  });

  it('returns the fallback for undefined', () => {
    expect(describeError(undefined)).toBe('Unknown error');
  });

  it('stringifies a number', () => {
    expect(describeError(42)).toBe('42');
  });

  it('stringifies a boolean', () => {
    expect(describeError(false)).toBe('false');
  });

  it('uses a custom fallback when provided', () => {
    expect(describeError(undefined, 'No details available')).toBe(
      'No details available',
    );
    expect(describeError({}, 'No details available')).toBe(
      'No details available',
    );
  });
});
