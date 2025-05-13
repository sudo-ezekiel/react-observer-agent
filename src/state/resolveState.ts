import type { StateSource } from '../types';

export function resolveState(state: StateSource): Record<string, unknown> {
  return typeof state === 'function' ? state() : state;
}
