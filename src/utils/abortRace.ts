export interface AbortRace {
  /**
   * Rejects with an `AbortError` when the signal fires, and never settles on
   * its own. Race it against consumer code so an abort ends the wait.
   */
  promise: Promise<never>;
  /**
   * Drops the listener. A caller signal can outlive many interactions, so
   * every race has to let go of it once the thing it guarded has settled.
   */
  release(): void;
}

const never = (): Promise<never> => new Promise<never>(() => {});

/**
 * Guards an await on consumer code that may never settle: a confirmation whose
 * UI unmounted, a handler that ignores `context.signal`. Racing gives the loop
 * back so the interaction ends and the queue drains. The consumer promise
 * itself keeps running, since JavaScript offers no way to cancel it; what the
 * race buys is that nothing waits on it forever.
 */
export function abortRace(signal?: AbortSignal): AbortRace {
  // Nothing can interrupt the race, so the guarded promise decides it alone.
  if (!signal) return { promise: never(), release: () => {} };

  let release = (): void => {};

  const promise = new Promise<never>((_resolve, reject) => {
    const rejectAborted = (): void => reject(abortReason(signal));

    if (signal.aborted) {
      rejectAborted();
      return;
    }

    signal.addEventListener('abort', rejectAborted, { once: true });
    release = (): void => signal.removeEventListener('abort', rejectAborted);
  });

  return { promise, release };
}

function abortReason(signal: AbortSignal): Error {
  // A cancel is recognized by `name === 'AbortError'`, and a caller may abort
  // with any reason at all, so anything else is wrapped rather than passed on.
  const { reason } = signal;
  if (reason instanceof Error && reason.name === 'AbortError') return reason;

  const error = new Error('Interaction aborted');
  error.name = 'AbortError';
  return error;
}
