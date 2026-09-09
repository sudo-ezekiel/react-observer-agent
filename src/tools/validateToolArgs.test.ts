import { describe, expect, it } from 'vitest';
import { validateToolArgs } from './validateToolArgs';
import { registerTool } from './registerTool';
import type { StandardSchemaV1 } from '../types';

describe('validateToolArgs', () => {
  it('prefers the schema over parameters when both are present', async () => {
    const schema: StandardSchemaV1<{ id: string }, { id: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as { id: string } }),
      },
    };

    // The JSON Schema would reject this value: `id` is missing.
    const tool = registerTool('lookup', () => undefined, {
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      schema,
    });

    const result = await validateToolArgs(tool, { other: 'value' });

    expect(result).toEqual({ valid: true, value: { other: 'value' } });
  });

  it('formats an issue path made of string and object path segments', async () => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({
          issues: [
            {
              message: 'must be a positive number',
              path: ['user', { key: 'age' }],
            },
          ],
        }),
      },
    };

    const tool = registerTool('setAge', () => undefined, { schema });

    const result = await validateToolArgs(tool, { user: { age: -1 } });

    expect(result).toEqual({
      valid: false,
      errors: ['user.age: must be a positive number'],
    });
  });

  it('supports an async validate function', async () => {
    const schema: StandardSchemaV1<{ ok: boolean }, { ok: boolean }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
          await Promise.resolve();
          return { value: value as { ok: boolean } };
        },
      },
    };

    const tool = registerTool('asyncCheck', () => undefined, { schema });

    const result = await validateToolArgs(tool, { ok: true });

    expect(result).toEqual({ valid: true, value: { ok: true } });
  });

  it('reports a throwing validate function as invalid instead of rejecting', async () => {
    const schema: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => {
          throw new Error('validator exploded');
        },
      },
    };

    const tool = registerTool('brokenSchema', () => undefined, { schema });

    const result = await validateToolArgs(tool, {});

    expect(result).toEqual({ valid: false, errors: ['validator exploded'] });
  });
});
