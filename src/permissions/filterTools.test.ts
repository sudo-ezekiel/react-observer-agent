import { describe, expect, it } from 'vitest';
import { filterTools } from './filterTools';
import { registerTool } from '../tools/registerTool';

describe('filterTools', () => {
  const tools = [
    registerTool('navigate', () => {}),
    registerTool('addToCart', () => {}),
    registerTool('clearCart', () => {}),
  ];

  it('returns only tools whose names are in canExecute', () => {
    const result = filterTools(tools, ['navigate', 'clearCart']);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(['navigate', 'clearCart']);
  });

  it('returns empty array when canExecute is empty', () => {
    expect(filterTools(tools, [])).toEqual([]);
  });

  it('returns empty array when no tools match', () => {
    expect(filterTools(tools, ['unknown'])).toEqual([]);
  });

  it('ignores canExecute names not present in tools', () => {
    const result = filterTools(tools, ['navigate', 'nonexistent']);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('navigate');
  });

  it('returns all tools when all are in canExecute', () => {
    const result = filterTools(tools, ['navigate', 'addToCart', 'clearCart']);
    expect(result).toHaveLength(3);
  });
});
