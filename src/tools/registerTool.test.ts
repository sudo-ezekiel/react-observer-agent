import { describe, it, expect } from 'vitest';
import { registerTool } from './registerTool';
import type { ToolOptions, StandardSchemaV1 } from '../types';

describe('registerTool', () => {
  it('returns a tool definition with correct shape', () => {
    const tool = registerTool('myTool', () => 'result');

    expect(tool).toEqual({
      name: 'myTool',
      handler: expect.any(Function),
      description: undefined,
      parameters: undefined,
      confirm: false,
    });
  });

  it('includes description and parameters from options', () => {
    const params = {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    };

    const tool = registerTool('addItem', (_args: { id: string }) => 'added', {
      description: 'Add an item',
      parameters: params,
    });

    expect(tool.name).toBe('addItem');
    expect(tool.description).toBe('Add an item');
    expect(tool.parameters).toEqual(params);
    expect(tool.confirm).toBe(false);
  });

  it('sets confirm to true when specified', () => {
    const tool = registerTool('dangerousTool', () => {}, { confirm: true });

    expect(tool.confirm).toBe(true);
  });

  it('defaults confirm to false when not specified', () => {
    const tool = registerTool('safeTool', () => {});

    expect(tool.confirm).toBe(false);
  });

  it('handler is callable and returns expected result', () => {
    const tool = registerTool('greet', (args: { name: string }) => {
      return `Hello, ${args.name}!`;
    });

    const result = tool.handler({ name: 'World' });
    expect(result).toBe('Hello, World!');
  });

  it('handler supports async functions', async () => {
    const tool = registerTool('asyncTool', async (args: { n: number }) => {
      return args.n * 2;
    });

    const result = await tool.handler({ n: 5 });
    expect(result).toBe(10);
  });

  it('stores the schema when registered through the schema overload', () => {
    const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as { name: string } }),
      },
    };

    const tool = registerTool('withSchema', (args) => args.name, {
      description: 'Uses a schema',
      schema,
    });

    expect(tool.schema).toBe(schema);
  });

  it('accepts an explicit generic with a matching parameters schema', () => {
    const tool = registerTool<{ path: string }>(
      'deleteFile',
      (args) => `deleted ${args.path}`,
      {
        description: 'Delete a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    );

    expect(tool.name).toBe('deleteFile');
    expect(tool.handler({ path: '/tmp/a' })).toBe('deleted /tmp/a');
    expect(tool.schema).toBeUndefined();
  });

  it('accepts a plain ToolOptions variable with no schema at runtime', () => {
    const options: ToolOptions = {
      description: 'Plain options',
      confirm: true,
    };

    const tool = registerTool('plainOptionsTool', () => 'ok', options);

    expect(tool.description).toBe('Plain options');
    expect(tool.confirm).toBe(true);
    expect(tool.schema).toBeUndefined();
  });

  it('runs a handler that reads the context second argument', () => {
    const tool = registerTool('withContext', (args: { n: number }, context) => {
      return { n: args.n, aborted: context?.signal?.aborted ?? false };
    });

    const controller = new AbortController();
    const result = tool.handler({ n: 1 }, { signal: controller.signal });

    expect(result).toEqual({ n: 1, aborted: false });
  });
});
