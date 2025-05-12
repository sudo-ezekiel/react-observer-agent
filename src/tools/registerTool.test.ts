import { describe, it, expect } from 'vitest';
import { registerTool } from './registerTool';

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

    const tool = registerTool(
      'addItem',
      (_args: { id: string }) => 'added',
      {
        description: 'Add an item',
        parameters: params,
      },
    );

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
});
