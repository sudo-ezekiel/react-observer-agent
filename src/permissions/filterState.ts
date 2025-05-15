export function filterState(
  state: Record<string, unknown>,
  canAccess: string[],
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const key of canAccess) {
    if (key in state) {
      filtered[key] = state[key];
    }
  }
  return filtered;
}
