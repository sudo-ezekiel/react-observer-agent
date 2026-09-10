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

registerTool(
  'inferredFromSchema',
  (args) => {
    expectTypeOf(args).toEqualTypeOf<{ name: string }>();
    return args.name;
  },
  { description: 'Uses a schema', schema: nameSchema },
);

registerTool(
  'annotatedAgreesWithSchema',
  (args: { name: string }) => args.name,
  { description: 'Uses a schema', schema: nameSchema },
);

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

const plainOptions: ToolOptions = { description: 'Plain options' };
registerTool(
  'annotatedWithPlainOptions',
  (args: { id: string }) => args.id,
  plainOptions,
);

registerTool('noOptions', (args: { id: string }) => args.id);

registerTool('oneArgumentHandler', (args: { id: string }) => {
  return args.id;
});

registerTool('twoArgumentHandler', (args: { id: string }, context) => {
  expectTypeOf(context).toEqualTypeOf<ToolContext | undefined>();
  return args.id;
});

registerTool<{ id: string }>(
  'explicitGenericWithPlainOptionsVar',
  (args) => args.id,
  plainOptions,
);

// Explicit generic plus a `ToolOptions`-typed variable that does carry a
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

// @ts-expect-error handler args type disagrees with the inline schema output
registerTool(
  'annotatedDisagreesWithSchema',
  (args: { id: number }) => args.id,
  {
    description: 'Disagrees with the schema',
    schema: idStringSchema,
  },
);

// The default `O` for the second overload omits `schema`, so an inline
// `schema` here is an excess property, reported on the `schema` property
// itself.
registerTool<{ id: string }>(
  'explicitGenericWithDisagreeingSchema',
  (args) => args.id,
  {
    description: 'Explicit generic with a disagreeing schema',
    // @ts-expect-error an inline schema next to an explicit generic is an excess property
    schema: idNumberSchema,
  },
);

registerTool<{ id: string }>(
  'explicitGenericWithAgreeingSchema',
  (args) => args.id,
  {
    description: 'Explicit generic with an agreeing schema',
    // @ts-expect-error an inline schema next to an explicit generic is an excess property
    schema: idStringSchema,
  },
);
