import type { ToolDefinition, ToolOptions } from '../types';

export function registerTool<TArgs = unknown>(
  name: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  options?: ToolOptions,
): ToolDefinition<TArgs> {
  return {
    name,
    handler,
    description: options?.description,
    parameters: options?.parameters,
    confirm: options?.confirm ?? false,
  };
}
