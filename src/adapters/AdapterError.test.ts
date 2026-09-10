import { describe, expect, it, expectTypeOf } from 'vitest';
import { AdapterError } from './AdapterError';

describe('AdapterError', () => {
  it('has the name "AdapterError" at runtime', () => {
    const error = new AdapterError('boom');
    expect(error.name).toBe('AdapterError');
  });

  it('is an instance of AdapterError and Error', () => {
    const error = new AdapterError('boom');
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toBeInstanceOf(Error);
  });

  it('types name as the literal "AdapterError"', () => {
    expectTypeOf(new AdapterError('boom').name).toEqualTypeOf<'AdapterError'>();
  });
});
