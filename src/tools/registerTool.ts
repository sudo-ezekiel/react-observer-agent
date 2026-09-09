import type {
  InferSchemaOutput,
  StandardSchemaV1,
  ToolDefinition,
  ToolHandler,
  ToolOptions,
} from '../types';

/** With a Standard Schema, the handler's argument type comes from the schema. */
export function registerTool<S extends StandardSchemaV1>(
  name: string,
  handler: ToolHandler<InferSchemaOutput<S>>,
  options: ToolOptions & { schema: S },
): ToolDefinition<InferSchemaOutput<S>>;
export function registerTool<TArgs = unknown>(
  name: string,
  handler: ToolHandler<TArgs>,
  options?: ToolOptions,
): ToolDefinition<TArgs>;
export function registerTool<TArgs = unknown>(
  name: string,
  handler: ToolHandler<TArgs>,
  options?: ToolOptions,
): ToolDefinition<TArgs> {
  return {
    name,
    handler,
    description: options?.description,
    parameters: options?.parameters,
    schema: options?.schema,
    confirm: options?.confirm ?? false,
  };
}
