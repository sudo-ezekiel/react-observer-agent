import type { ToolDefinition } from '../types';

export function validateToolNames(tools: ToolDefinition[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `Duplicate tool name "${tool.name}". All tools passed to a single provider must have unique names.`,
      );
    }
    seen.add(tool.name);
  }
}
