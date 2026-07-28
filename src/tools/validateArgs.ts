import type { JSONSchema } from '../types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates tool arguments against a deliberate subset of JSON Schema:
 * `type`, `properties`, `required`, `items`, and `enum`. Every other keyword
 * is ignored rather than rejected, so a richer real-world schema still
 * validates on the parts this understands instead of failing outright.
 */
export function validateArgs(args: unknown, schema: JSONSchema): ValidationResult {
  const errors: string[] = [];
  validateValue(args, schema, '', errors);
  return { valid: errors.length === 0, errors };
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = describeType(value);
  // Every integer is a valid number, but not the reverse.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function label(path: string): string {
  return path === '' ? 'value' : path;
}

function validateValue(
  value: unknown,
  schema: JSONSchema,
  path: string,
  errors: string[],
): void {
  if (!schema || typeof schema !== 'object') return;

  const expectedType = schema.type;
  if (typeof expectedType === 'string' && !matchesType(value, expectedType)) {
    errors.push(
      `${label(path)} should be ${expectedType}, got ${describeType(value)}`,
    );
    // Anything further would just restate the same mismatch.
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => sameValue(option, value))) {
    errors.push(
      `${label(path)} should be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
    );
  }

  if (isPlainObject(value)) {
    validateObject(value, schema, path, errors);
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    const itemSchema = schema.items as JSONSchema;
    value.forEach((item, index) => {
      validateValue(item, itemSchema, `${label(path)}[${index}]`, errors);
    });
  }
}

function validateObject(
  value: Record<string, unknown>,
  schema: JSONSchema,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === 'string' && value[key] === undefined) {
        errors.push(`${path === '' ? '' : `${path}.`}${key} is required`);
      }
    }
  }

  if (isPlainObject(schema.properties)) {
    const properties = schema.properties as Record<string, JSONSchema>;
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (value[key] !== undefined && isPlainObject(propertySchema)) {
        validateValue(
          value[key],
          propertySchema,
          path === '' ? key : `${path}.${key}`,
          errors,
        );
      }
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
