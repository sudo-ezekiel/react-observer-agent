export interface LinkedSignal {
  /** Aborted as soon as any of the linked sources is. */
  signal: AbortSignal;
  /**
   * Drops the listeners. A caller signal can outlive many interactions, so
   * every linked signal has to let go of it once its interaction settles.
   */
  release(): void;
}

/**
 * Combines abort signals into one. Undefined sources are ignored, so a caller
 * that passed no signal still gets a working linked signal.
 */
export function linkSignals(
  ...sources: (AbortSignal | undefined)[]
): LinkedSignal {
  const controller = new AbortController();
  const listeners: { source: AbortSignal; listener: () => void }[] = [];

  const release = (): void => {
    for (const { source, listener } of listeners) {
      source.removeEventListener('abort', listener);
    }
    listeners.length = 0;
  };

  for (const source of sources) {
    if (!source) continue;

    if (source.aborted) {
      abortWith(controller, source);
      release();
      break;
    }

    const listener = (): void => abortWith(controller, source);
    source.addEventListener('abort', listener, { once: true });
    listeners.push({ source, listener });
  }

  return { signal: controller.signal, release };
}

function abortWith(controller: AbortController, source: AbortSignal): void {
  // abort(undefined) would replace the default AbortError reason with nothing,
  // and the abort reason is what an adapter rejects a forwarded fetch with.
  if (source.reason === undefined) {
    controller.abort();
    return;
  }
  controller.abort(source.reason);
}
