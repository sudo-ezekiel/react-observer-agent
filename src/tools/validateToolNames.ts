import type { ToolDefinition } from '../types';

const RESERVED_PREFIX = '__';

export function validateToolNames(tools: ToolDefinition[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (tool.name.startsWith(RESERVED_PREFIX)) {
      throw new Error(
        `Tool name "${tool.name}" uses the reserved "${RESERVED_PREFIX}" prefix. ` +
          `Names beginning with "${RESERVED_PREFIX}" are reserved for internal tools.`,
      );
    }
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate tool name "${tool.name}". All tools passed to a single provider must have unique names.`,
      );
    }
    seen.add(tool.name);
  }
}
