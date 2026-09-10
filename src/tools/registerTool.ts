import type {
  InferSchemaOutput,
  StandardSchemaV1,
  ToolDefinition,
  ToolHandler,
  ToolOptions,
} from '../types';

/**
 * With a Standard Schema, the handler's argument type comes from the schema.
 *
 * `schema` is omitted before the intersection rather than narrowed in place.
 * Intersecting leaves `StandardSchemaV1 & S`, and checking a validator against
 * that walks its self-referential methods: a Zod 3 object has `deepPartial()`
 * returning a different object type, which cannot satisfy the intersection, so
 * the call fails to match this overload. Omitting the key first leaves `S`
 * alone and costs nothing, since `S` is already constrained to a validator.
 */
export function registerTool<S extends StandardSchemaV1>(
  name: string,
  handler: ToolHandler<InferSchemaOutput<S>>,
  options: Omit<ToolOptions, 'schema'> & { schema: S },
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
