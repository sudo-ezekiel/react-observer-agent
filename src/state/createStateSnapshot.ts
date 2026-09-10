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

/**
 * One oversized key would otherwise spend the whole context window on a read
 * the model cannot take back.
 */
function applyByteLimit(
  snapshot: Record<string, unknown>,
  maxBytes: number,
  debug: boolean,
): Record<string, unknown> {
  const limited: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(snapshot)) {
    // Undefined has no JSON representation, so there is nothing to measure.
    const json = JSON.stringify(value);
    if (json === undefined || json.length <= maxBytes) {
      limited[key] = value;
      continue;
    }

    if (debug) {
      console.warn(
        `[react-observer-agent] State key "${key}" is ${json.length} bytes, over the ${maxBytes} byte limit, and was truncated`,
      );
    }

    limited[key] = {
      __truncated: true,
      limit: maxBytes,
      bytes: json.length,
      preview: json.slice(0, maxBytes),
    };
  }

  return limited;
}

export function createStateSnapshot(
  state: StateSource,
  canAccess: string[],
  debug: boolean = false,
  maxBytes?: number,
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

  const snapshot = stripNonSerializable(filtered, debug);

  return maxBytes === undefined
    ? snapshot
    : applyByteLimit(snapshot, maxBytes, debug);
}
