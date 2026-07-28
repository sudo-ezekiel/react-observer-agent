import { describe, it, expect } from 'vitest';
import { registerTool } from './registerTool';
import { validateToolNames } from './validateToolNames';

describe('validateToolNames', () => {
  it('passes with unique tool names', () => {
    const tools = [
      registerTool('toolA', () => {}),
      registerTool('toolB', () => {}),
      registerTool('toolC', () => {}),
    ];

    expect(() => validateToolNames(tools)).not.toThrow();
  });

  it('throws on duplicate tool names', () => {
    const tools = [
      registerTool('duplicate', () => {}),
      registerTool('unique', () => {}),
      registerTool('duplicate', () => {}),
    ];

    expect(() => validateToolNames(tools)).toThrowError(
      'Duplicate tool name "duplicate"',
    );
  });

  it('passes with an empty tools array', () => {
    expect(() => validateToolNames([])).not.toThrow();
  });

  it('passes with a single tool', () => {
    const tools = [registerTool('only', () => {})];

    expect(() => validateToolNames(tools)).not.toThrow();
  });

  it('detects duplicates at any position', () => {
    const tools = [
      registerTool('a', () => {}),
      registerTool('b', () => {}),
      registerTool('c', () => {}),
      registerTool('b', () => {}),
    ];

    expect(() => validateToolNames(tools)).toThrowError(
      'Duplicate tool name "b"',
    );
  });

  it('throws when a tool shadows the internal readState tool', () => {
    const tools = [registerTool('__readState', () => {})];

    expect(() => validateToolNames(tools)).toThrowError(
      /reserved "__" prefix/,
    );
  });

  it('throws on any name using the reserved prefix', () => {
    const tools = [
      registerTool('safeTool', () => {}),
      registerTool('__anything', () => {}),
    ];

    expect(() => validateToolNames(tools)).toThrowError(
      /reserved "__" prefix/,
    );
  });

  it('allows underscores that are not a leading double underscore', () => {
    const tools = [
      registerTool('_private', () => {}),
      registerTool('my__tool', () => {}),
      registerTool('snake_case', () => {}),
    ];

    expect(() => validateToolNames(tools)).not.toThrow();
  });
});
