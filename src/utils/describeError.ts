/**
 * Best-effort human-readable text for a thrown value. Handlers, adapters and
 * schema validators are consumer code, so what reaches a catch is not always an
 * Error: a thrown string or a rejected `{ code, message }` object still carries
 * the reason and must not be flattened into the fallback.
 */
export function describeError(
  error: unknown,
  fallback = 'Unknown error',
): string {
  if (error instanceof Error) {
    return error.message || error.name || fallback;
  }

  if (typeof error === 'string') {
    return error || fallback;
  }

  if (error === null || error === undefined) {
    return fallback;
  }

  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') {
      return message;
    }

    try {
      const serialized = JSON.stringify(error);
      // '{}' means nothing survived serialization, which says no more than the
      // fallback does. A circular structure or a throwing toJSON lands in catch.
      if (typeof serialized === 'string' && serialized !== '{}') {
        return serialized;
      }
    } catch {
      return fallback;
    }
    return fallback;
  }

  return String(error);
}
