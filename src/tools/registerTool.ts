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
/**
 * Without a schema the argument type is the handler's own. The conditional
 * keeps an inferred schema whose output disagrees with that type from falling
 * through to here instead of failing. `O` defaults to options without a
 * `schema` key because an explicit type argument turns inference off, and with
 * it the conditional: an inline schema next to an explicit type argument would
 * leave two unchecked sources of truth for `TArgs`, so it is an excess
 * property error. Drop the type argument and let the schema supply it. A
 * variable typed as plain `ToolOptions` still passes, with or without an
 * explicit type argument, since its schema output is `unknown`.
 */
export function registerTool<
  TArgs = unknown,
  O extends ToolOptions = Omit<ToolOptions, 'schema'>,
>(
  name: string,
  handler: ToolHandler<TArgs>,
  options?: O &
    (O extends { schema: StandardSchemaV1 }
      ? { schema: StandardSchemaV1<unknown, TArgs> }
      : unknown),
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
