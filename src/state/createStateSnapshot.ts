import type { StateSource } from '../types';
import { resolveState } from './resolveState';

export function stripNonSerializable(
  obj: Record<string, unknown>,
  debug: boolean = false,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    try {
      JSON.stringify(value);
      result[key] = value;
    } catch {
      if (debug) {
        console.warn(
          `[react-observer-agent] Non-serializable value stripped from state key "${key}"`,
        );
      }
    }
  }

  return result;
}

function isSerializableValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'function' || typeof value === 'symbol') return false;
  if (typeof value === 'bigint') return false;
  return true;
}

export function createStateSnapshot(
  state: StateSource,
  canAccess: string[],
  debug: boolean = false,
): Record<string, unknown> {
  const resolved = resolveState(state);
  const filtered: Record<string, unknown> = {};

  for (const key of canAccess) {
    if (key in resolved) {
      const value = resolved[key];
      if (!isSerializableValue(value)) {
        if (debug) {
          console.warn(
            `[react-observer-agent] Non-serializable value stripped from state key "${key}"`,
          );
        }
        continue;
      }
      filtered[key] = value;
    }
  }

  return stripNonSerializable(filtered, debug);
}
