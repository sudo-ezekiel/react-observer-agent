import type {
  AnyToolDefinition,
  StandardSchemaIssue,
  StandardSchemaResult,
} from '../types';
import { validateArgs } from './validateArgs';
import { describeError } from '../utils/describeError';

export type ToolArgsValidation =
  | { valid: true; value: unknown }
  | { valid: false; errors: string[] };

/**
 * Validates tool arguments, preferring a Standard Schema when the tool carries
 * one. The returned `value` is what the handler should receive: a schema may
 * apply defaults or transforms, so it is not always the input.
 */
export async function validateToolArgs(
  tool: AnyToolDefinition,
  args: unknown,
): Promise<ToolArgsValidation> {
  if (tool.schema) {
    let result: StandardSchemaResult<unknown>;
    try {
      result = await tool.schema['~standard'].validate(args);
    } catch (error) {
      return { valid: false, errors: [describeError(error)] };
    }

    if (result.issues) {
      return { valid: false, errors: result.issues.map(formatIssue) };
    }
    return { valid: true, value: result.value };
  }

  if (tool.parameters) {
    const validation = validateArgs(args, tool.parameters);
    if (!validation.valid) {
      return { valid: false, errors: validation.errors };
    }
  }

  return { valid: true, value: args };
}

function formatIssue(issue: StandardSchemaIssue): string {
  const path = (issue.path ?? [])
    .map((segment) =>
      String(
        typeof segment === 'object' && segment !== null ? segment.key : segment,
      ),
    )
    .join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
