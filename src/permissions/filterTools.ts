import type { ToolDefinition } from '../types';

export function filterTools(
  tools: ToolDefinition[],
  canExecute: string[],
): ToolDefinition[] {
  const allowed = new Set(canExecute);
  return tools.filter((tool) => allowed.has(tool.name));
}
