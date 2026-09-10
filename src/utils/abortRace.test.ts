import { describe, expect, it, vi } from 'vitest';
import { abortRace } from './abortRace';

function delay(ms: number): Promise<'timer'> {
  return new Promise((resolve) => setTimeout(() => resolve('timer'), ms));
}

describe('abortRace', () => {
  it('never settles when there is no signal', async () => {
    const { promise } = abortRace(undefined);

    const winner = await Promise.race([
      promise,
      Promise.resolve('resolved'),
      delay(20),
    ]);

    expect(winner).toBe('resolved');
  });

  it('rejects immediately with an AbortError for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const { promise } = abortRace(controller.signal);

    await expect(promise).rejects.toThrow();
    try {
      await promise;
      throw new Error('promise should have rejected');
    } catch (error) {
      expect((error as Error).name).toBe('AbortError');
    }
  });

  it('rejects with an AbortError when the signal aborts later', async () => {
    const controller = new AbortController();
    const { promise } = abortRace(controller.signal);

    const outcome = Promise.race([
      promise.then(() => 'resolved' as const).catch((error: Error) => error),
      delay(50),
    ]);

    controller.abort();

    const result = await outcome;
    expect(result).not.toBe('timer');
    expect((result as Error).name).toBe('AbortError');
  });

  it('passes through a caller reason that is already an AbortError-named Error', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled by caller');
    reason.name = 'AbortError';
    controller.abort(reason);

    const { promise } = abortRace(controller.signal);

    try {
      await promise;
      throw new Error('promise should have rejected');
    } catch (error) {
      expect(error).toBe(reason);
    }
  });

  it('wraps a non-Error abort reason into an AbortError instead of surfacing it as-is', async () => {
    const controller = new AbortController();
    controller.abort('because');

    const { promise } = abortRace(controller.signal);

    try {
      await promise;
      throw new Error('promise should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('AbortError');
      expect(error).not.toBe('because');
    }
  });

  it('wraps a non-AbortError Error reason into an AbortError instead of surfacing it as-is', async () => {
    const controller = new AbortController();
    const boom = new Error('boom');
    controller.abort(boom);

    const { promise } = abortRace(controller.signal);

    try {
      await promise;
      throw new Error('promise should have rejected');
    } catch (error) {
      expect(error).not.toBe(boom);
      expect((error as Error).name).toBe('AbortError');
    }
  });

  it('drops the listener on release, so a later abort no longer rejects the promise', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const { promise, release } = abortRace(controller.signal);

    release();
    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));

    controller.abort();

    const winner = await Promise.race([
      promise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      delay(20),
    ]);

    expect(winner).toBe('timer');
  });

  it('produces no unhandled rejection when the guarded promise resolves first and release is called', async () => {
    const controller = new AbortController();
    const { promise, release } = abortRace(controller.signal);

    promise.catch(() => {});

    const guarded = Promise.resolve('done');
    const winner = await Promise.race([guarded, promise]);
    release();
    controller.abort();

    expect(winner).toBe('done');
  });
});
