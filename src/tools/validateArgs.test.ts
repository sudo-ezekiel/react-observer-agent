import { describe, expect, it } from 'vitest';
import { validateArgs } from './validateArgs';

describe('validateArgs', () => {
  describe('type checking', () => {
    it('accepts a matching primitive type', () => {
      expect(validateArgs('hello', { type: 'string' }).valid).toBe(true);
      expect(validateArgs(3, { type: 'number' }).valid).toBe(true);
      expect(validateArgs(true, { type: 'boolean' }).valid).toBe(true);
      expect(validateArgs(null, { type: 'null' }).valid).toBe(true);
    });

    it('rejects a mismatched primitive type with a readable message', () => {
      const result = validateArgs(42, { type: 'string' });

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['value should be string, got integer']);
    });

    it('accepts an integer where a number is expected', () => {
      expect(validateArgs(5, { type: 'number' }).valid).toBe(true);
    });

    it('rejects a fractional number where an integer is expected', () => {
      expect(validateArgs(5.5, { type: 'integer' }).valid).toBe(false);
    });

    it('distinguishes arrays from objects', () => {
      expect(validateArgs([], { type: 'object' }).valid).toBe(false);
      expect(validateArgs({}, { type: 'array' }).valid).toBe(false);
      expect(validateArgs([], { type: 'array' }).valid).toBe(true);
    });

    it('reports missing arguments against an object schema', () => {
      const result = validateArgs(undefined, {
        type: 'object',
        properties: {},
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('got undefined');
    });
  });

  describe('required properties', () => {
    const schema = {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    };

    it('accepts an object with all required properties', () => {
      expect(validateArgs({ productId: 'abc' }, schema).valid).toBe(true);
    });

    it('rejects an object missing a required property', () => {
      const result = validateArgs({}, schema);

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['productId is required']);
    });

    it('treats an explicit undefined as missing', () => {
      expect(validateArgs({ productId: undefined }, schema).valid).toBe(false);
    });

    it('reports every missing property, not just the first', () => {
      const result = validateArgs(
        {},
        { type: 'object', properties: {}, required: ['a', 'b'] },
      );

      expect(result.errors).toEqual(['a is required', 'b is required']);
    });
  });

  describe('nested schemas', () => {
    it('validates nested object properties with a dotted path', () => {
      const result = validateArgs(
        { user: { age: 'old' } },
        {
          type: 'object',
          properties: {
            user: { type: 'object', properties: { age: { type: 'integer' } } },
          },
        },
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['user.age should be integer, got string']);
    });

    it('validates array items with an indexed path', () => {
      const result = validateArgs(
        { ids: ['a', 2] },
        {
          type: 'object',
          properties: { ids: { type: 'array', items: { type: 'string' } } },
        },
      );

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual(['ids[1] should be string, got integer']);
    });

    it('accepts a well-formed nested payload', () => {
      const result = validateArgs(
        { items: [{ sku: 'a' }, { sku: 'b' }] },
        {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: { sku: { type: 'string' } },
                required: ['sku'],
              },
            },
          },
        },
      );

      expect(result.valid).toBe(true);
    });
  });

  describe('enum', () => {
    const schema = { type: 'string', enum: ['home', 'cart'] };

    it('accepts a listed value', () => {
      expect(validateArgs('cart', schema).valid).toBe(true);
    });

    it('rejects an unlisted value', () => {
      const result = validateArgs('checkout', schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('should be one of');
    });
  });

  describe('unsupported keywords', () => {
    it('ignores keywords it does not implement rather than failing', () => {
      const result = validateArgs(
        { name: 'x' },
        {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 10, pattern: '^\\d+$' },
          },
          additionalProperties: false,
          $schema: 'https://json-schema.org/draft/2020-12/schema',
        },
      );

      expect(result.valid).toBe(true);
    });

    it('ignores an empty schema', () => {
      expect(validateArgs({ anything: true }, {}).valid).toBe(true);
    });

    it('allows properties the schema does not describe', () => {
      const result = validateArgs(
        { known: 'a', extra: 1 },
        { type: 'object', properties: { known: { type: 'string' } } },
      );

      expect(result.valid).toBe(true);
    });
  });
});
