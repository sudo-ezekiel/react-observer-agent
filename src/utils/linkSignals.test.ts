import { describe, expect, it } from 'vitest';
import { linkSignals } from './linkSignals';

describe('linkSignals', () => {
  it('aborts the linked signal immediately when a source is already aborted', () => {
    const controller = new AbortController();
    controller.abort('already gone');

    const { signal } = linkSignals(controller.signal);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('already gone');
  });

  it('aborts the linked signal when a source aborts later', () => {
    const controller = new AbortController();
    const { signal } = linkSignals(controller.signal);

    expect(signal.aborted).toBe(false);

    controller.abort('gone now');

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('gone now');
  });

  it('ignores undefined sources', () => {
    const controller = new AbortController();
    const { signal } = linkSignals(undefined, controller.signal, undefined);

    expect(signal.aborted).toBe(false);

    controller.abort('reason');

    expect(signal.aborted).toBe(true);
  });

  it('stops reacting to a source abort after release', () => {
    const controller = new AbortController();
    const { signal, release } = linkSignals(controller.signal);

    release();
    controller.abort('too late');

    expect(signal.aborted).toBe(false);
  });

  it('does not turn a reasonless abort into an undefined reason', () => {
    const controller = new AbortController();
    const { signal } = linkSignals(controller.signal);

    controller.abort();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeDefined();
    expect((signal.reason as { name?: string }).name).toBe('AbortError');
  });
});
