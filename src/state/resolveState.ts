import type { StateSource } from '../types';

export function resolveState(state: StateSource): Record<string, unknown> {
  const resolved = typeof state === 'function' ? state() : state;
  return resolved as Record<string, unknown>;
}
