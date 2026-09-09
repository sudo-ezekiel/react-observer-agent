/**
 * Thrown by the built-in adapters. Carries the HTTP status and raw body when
 * the failure came from a response, so callers can tell a 401 from a 429
 * without parsing the message.
 */
export class AdapterError extends Error {
  readonly status?: number;
  readonly body?: string;

  constructor(
    message: string,
    options?: { status?: number; body?: string; cause?: unknown },
  ) {
    super(message);
    this.name = 'AdapterError';
    this.status = options?.status;
    this.body = options?.body;
    if (options?.cause !== undefined) {
      // Assigned rather than passed to super: the ES2020 lib this package
      // compiles against does not type Error's options argument.
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}
