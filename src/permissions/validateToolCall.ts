export function validateToolCall(
  name: string,
  canExecute: string[],
): boolean {
  return canExecute.includes(name);
}
