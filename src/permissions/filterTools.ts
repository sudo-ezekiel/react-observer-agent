import type { AnyToolDefinition } from '../types';

export function filterTools(
  tools: AnyToolDefinition[],
  canExecute: string[],
): AnyToolDefinition[] {
  const allowed = new Set(canExecute);
  return tools.filter((tool) => allowed.has(tool.name));
}
