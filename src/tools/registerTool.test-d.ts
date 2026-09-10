/**
 * Compile-time coverage for the registerTool overloads (I4). This file uses
 * the `.test-d.ts` suffix so `tsconfig.json`'s `**\/*.test.ts` exclusion does
 * not skip it: `npm run typecheck` (`tsc --noEmit -p tsconfig.json`) checks
 * it, while vitest's `include` pattern never picks it up, so nothing here
 * runs at test time. Every `@ts-expect-error` below is load-bearing: remove
 * one and `npm run typecheck` must fail on that line.
 */
import { expectTypeOf } from 'vitest';
import { registerTool } from './registerTool';
import type { StandardSchemaV1, ToolContext, ToolOptions } from '../types';

function makeSchema<Input, Output>(
  cast: (value: unknown) => Output,
): StandardSchemaV1<Input, Output> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value) => ({ value: cast(value) }),
    },
  };
}

const nameSchema: StandardSchemaV1<{ name: string }, { name: string }> =
  makeSchema((v) => v as { name: string });

const idNumberSchema: StandardSchemaV1<{ id: number }, { id: number }> =
  makeSchema((v) => v as { id: number });

const idStringSchema: StandardSchemaV1<{ id: string }, { id: string }> =
  makeSchema((v) => v as { id: string });

// --- Must compile ---

// (a) An un-annotated handler with an inline schema infers the schema output.
registerTool(
  'inferredFromSchema',
  (args) => {
    expectTypeOf(args).toEqualTypeOf<{ name: string }>();
    return args.name;
  },
  { description: 'Uses a schema', schema: nameSchema },
);

// (b) An annotated handler that agrees with the inline schema output.
registerTool(
  'annotatedAgreesWithSchema',
  (args: { name: string }) => args.name,
  { description: 'Uses a schema', schema: nameSchema },
);

// (c) Explicit generic with an inline `{ description, parameters }` (no schema).
registerTool<{ path: string }>(
  'explicitGenericWithParameters',
  (args) => args.path,
  {
    description: 'Delete a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
  },
);

// (d) A `const opts: ToolOptions` variable with an annotated handler and no
// explicit generic.
const plainOptions: ToolOptions = { description: 'Plain options' };
registerTool(
  'annotatedWithPlainOptions',
  (args: { id: string }) => args.id,
  plainOptions,
);

// (e) No options at all.
registerTool('noOptions', (args: { id: string }) => args.id);

// (f) A one-argument handler (no context parameter).
registerTool('oneArgumentHandler', (args: { id: string }) => {
  return args.id;
});

// A two-argument handler still gets the context type.
registerTool('twoArgumentHandler', (args: { id: string }, context) => {
  expectTypeOf(context).toEqualTypeOf<ToolContext | undefined>();
  return args.id;
});

// (g) Explicit generic plus a `ToolOptions`-typed variable, without a schema.
registerTool<{ id: string }>(
  'explicitGenericWithPlainOptionsVar',
  (args) => args.id,
  plainOptions,
);

// (h) Explicit generic plus a `ToolOptions`-typed variable that does carry a
// schema at the type level: still passes, since `ToolOptions.schema` is
// optional and its output is unknown, so there is nothing to check against.
const optionsWithUncheckedSchema: ToolOptions = {
  description: 'Has a schema at the ToolOptions level',
  schema: nameSchema,
};
registerTool<{ id: string }>(
  'explicitGenericWithSchemaBearingOptionsVar',
  (args) => args.id,
  optionsWithUncheckedSchema,
);

// --- Must fail ---

// An annotated handler that disagrees with an inline schema is rejected at
// the call, since the schema overload requires the handler to accept exactly
// the schema's output type.
// @ts-expect-error handler args type disagrees with the inline schema output
registerTool(
  'annotatedDisagreesWithSchema',
  (args: { id: number }) => args.id,
  {
    description: 'Disagrees with the schema',
    schema: idStringSchema,
  },
);

// An explicit generic next to an inline schema is rejected even when the
// schema's output disagrees with the generic: the two would be unchecked,
// conflicting sources of truth for the argument type. The default `O` for
// the second overload omits `schema`, so an inline `schema` here is an
// excess property, reported on the `schema` property itself.
registerTool<{ id: string }>(
  'explicitGenericWithDisagreeingSchema',
  (args) => args.id,
  {
    description: 'Explicit generic with a disagreeing schema',
    // @ts-expect-error an inline schema next to an explicit generic is an excess property
    schema: idNumberSchema,
  },
);

// Same rule when the schema's output happens to agree with the explicit
// generic: still rejected, since the explicit generic and the inline schema
// remain two sources of truth for the same type.
registerTool<{ id: string }>(
  'explicitGenericWithAgreeingSchema',
  (args) => args.id,
  {
    description: 'Explicit generic with an agreeing schema',
    // @ts-expect-error an inline schema next to an explicit generic is an excess property
    schema: idStringSchema,
  },
);
