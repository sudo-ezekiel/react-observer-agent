import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { AIAgentProvider } from './AIAgentProvider';
import { useAgent } from './useAgent';
import { registerTool } from '../tools/registerTool';
import { AdapterError } from '../adapters/AdapterError';
import type {
  AgentResponse,
  ModelAdapter,
  ModelResponse,
  PermissionsConfig,
  ToolDefinition,
} from '../types';

function createMockAdapter(response?: Partial<ModelResponse>): ModelAdapter {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: '',
      toolCalls: [],
      ...response,
    }),
  };
}

const defaultPermissions: PermissionsConfig = {
  canAccess: ['count'],
  canExecute: ['increment'],
};

function createDefaultProps(
  overrides: Partial<Parameters<typeof AIAgentProvider>[0]> = {},
) {
  return {
    model: createMockAdapter(),
    state: { count: 0 },
    tools: [registerTool('increment', () => {})],
    permissions: defaultPermissions,
    ...overrides,
  };
}

function TestConsumer({
  onContext,
}: {
  onContext: (ctx: ReturnType<typeof useAgent>) => void;
}) {
  const ctx = useAgent();
  onContext(ctx);
  return <div data-testid="consumer">ready</div>;
}

describe('AIAgentProvider', () => {
  it('renders children', () => {
    render(
      <AIAgentProvider {...createDefaultProps()}>
        <div data-testid="child">Hello</div>
      </AIAgentProvider>,
    );
    expect(screen.getByTestId('child')).toBeDefined();
    expect(screen.getByTestId('child').textContent).toBe('Hello');
  });

  it('throws on duplicate tool names on mount', () => {
    const tools: ToolDefinition[] = [
      registerTool('dup', () => {}),
      registerTool('dup', () => {}),
    ];

    expect(() =>
      render(
        <AIAgentProvider {...createDefaultProps({ tools })}>
          <div />
        </AIAgentProvider>,
      ),
    ).toThrow(/Duplicate tool name/);
  });

  it('provides context via useAgent', () => {
    let captured: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(ctx) => {
            captured = ctx;
          }}
        />
      </AIAgentProvider>,
    );

    expect(captured).toBeDefined();
    expect(typeof captured!.send).toBe('function');
    expect(typeof captured!.clearHistory).toBe('function');
    expect(captured!.isProcessing).toBe(false);
    expect(captured!.history).toEqual([]);
    expect(captured!.lastResponse).toBeNull();
  });
});

describe('useAgent', () => {
  it('throws when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer onContext={() => {}} />)).toThrow(
      /useAgent\(\) must be used within an <AIAgentProvider>/,
    );
    spy.mockRestore();
  });
});

describe('send()', () => {
  it('returns a response with empty message and toolCalls', async () => {
    let ctx: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let response: AgentResponse | undefined;
    await act(async () => {
      response = await ctx!.send('hello');
    });

    expect(response).toBeDefined();
    expect(response!.message).toBe('');
    expect(response!.toolCalls).toEqual([]);
    expect(response!.error).toBeUndefined();
  });

  it('adds user and assistant entries to history', async () => {
    let ctx: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('test message');
    });

    expect(ctx!.history).toHaveLength(2);
    expect(ctx!.history[0].role).toBe('user');
    expect(ctx!.history[0].content).toBe('test message');
    expect(ctx!.history[1].role).toBe('assistant');
  });

  it('sets isProcessing back to false after completion', async () => {
    let ctx: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(ctx!.isProcessing).toBe(false);
  });

  it('updates lastResponse', async () => {
    let ctx: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(ctx!.lastResponse).toBeDefined();
    expect(ctx!.lastResponse!.message).toBe('');
    expect(ctx!.lastResponse!.toolCalls).toEqual([]);
  });
});

describe('clearHistory()', () => {
  it('resets history and lastResponse', async () => {
    let ctx: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps()}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(ctx!.history).toHaveLength(2);
    expect(ctx!.lastResponse).not.toBeNull();

    act(() => {
      ctx!.clearHistory();
    });

    expect(ctx!.history).toEqual([]);
    expect(ctx!.lastResponse).toBeNull();
  });
});

describe('error reporting', () => {
  it('reports a MAX_TURNS error through onError exactly once', async () => {
    const onError = vi.fn();
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'c1', name: 'increment', arguments: {} }],
      }),
    };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider
        {...createDefaultProps({ model, options: { maxTurns: 2, onError } })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('keep going');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe('MAX_TURNS');
    expect(ctx!.lastResponse?.error?.code).toBe('MAX_TURNS');
  });

  it('does not call onError when the consumer aborts', async () => {
    const onError = vi.fn();
    const controller = new AbortController();
    controller.abort();

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ options: { onError } })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let response: AgentResponse | undefined;
    await act(async () => {
      response = await ctx!.send('hello', { signal: controller.signal });
    });

    expect(response!.error?.code).toBe('ABORTED');
    expect(onError).not.toHaveBeenCalled();
    expect(ctx!.isProcessing).toBe(false);
  });

  it('does not call onError for a normal response', async () => {
    const onError = vi.fn();

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider
        {...createDefaultProps({
          model: createMockAdapter({ content: 'all good' }),
          options: { onError },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a thrown adapter failure through onError exactly once', async () => {
    const onError = vi.fn();
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockRejectedValue(new Error('network down')),
    };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model, options: { onError } })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('network down');
  });

  it('appends a user entry then an assistant entry carrying the error when the adapter throws', async () => {
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockRejectedValue(new Error('network down')),
    };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider
        {...createDefaultProps({ model, options: { onError: vi.fn() } })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(ctx!.history).toHaveLength(2);
    expect(ctx!.history[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(ctx!.history[1].role).toBe('assistant');
    expect(ctx!.history[1].content).toBe('');
    expect(ctx!.history[1].toolCalls).toEqual([]);
    expect(ctx!.history[1].error?.message).toBe('network down');
  });
});

describe('a throwing onError callback', () => {
  function createAlwaysToolCallModel(): ModelAdapter {
    return {
      sendMessage: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'c1', name: 'increment', arguments: {} }],
      }),
    };
  }

  it('propagates the callback error, fires onError once, and leaves one assistant entry with the real MAX_TURNS response', async () => {
    const onError = vi.fn(() => {
      throw new Error('boom');
    });
    const model = createAlwaysToolCallModel();

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider
        {...createDefaultProps({
          model,
          options: { maxTurns: 1, onError },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let caught: unknown;
    await act(async () => {
      try {
        await ctx!.send('hi');
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('boom');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(ctx!.history.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(ctx!.lastResponse?.error?.code).toBe('MAX_TURNS');
    expect(ctx!.isProcessing).toBe(false);

    let caughtSecond: unknown;
    await act(async () => {
      try {
        await ctx!.send('again');
      } catch (error) {
        caughtSecond = error;
      }
    });

    expect(caughtSecond).toBeInstanceOf(Error);
    expect((caughtSecond as Error).message).toBe('boom');
    expect(onError).toHaveBeenCalledTimes(2);
    expect(ctx!.history.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(ctx!.isProcessing).toBe(false);
  });
});

describe('conversation replay', () => {
  function sentMessages(model: ModelAdapter, callIndex: number) {
    return (model.sendMessage as ReturnType<typeof vi.fn>).mock.calls[
      callIndex
    ][0].messages;
  }

  it('replays prior tool calls and results with their structure intact', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'call_1', name: 'increment', arguments: { by: 1 } }],
      })
      .mockResolvedValueOnce({ content: 'Incremented.', toolCalls: [] })
      .mockResolvedValueOnce({ content: 'Yes, once.', toolCalls: [] });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('increment it');
    });
    await act(async () => {
      await ctx!.send('did you increment it?');
    });

    const replayed = sentMessages(model, 2);
    const assistantWithCall = replayed.find(
      (m: { toolCalls?: unknown[] }) => m.toolCalls && m.toolCalls.length > 0,
    );
    expect(assistantWithCall.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'increment',
      arguments: { by: 1 },
    });

    const toolResult = replayed.find(
      (m: { role: string }) => m.role === 'tool',
    );
    expect(toolResult.toolCallId).toBe('call_1');

    // The final answer from the first interaction is replayed too.
    expect(
      replayed.some((m: { content: string }) => m.content === 'Incremented.'),
    ).toBe(true);
    // And the new user message is last.
    expect(replayed[replayed.length - 1]).toEqual({
      role: 'user',
      content: 'did you increment it?',
    });
  });

  it('clearHistory resets the replayed transcript', async () => {
    const model = createMockAdapter({ content: 'ok' });

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('first');
    });
    act(() => {
      ctx!.clearHistory();
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([
      { role: 'user', content: 'second' },
    ]);
  });

  it('drops the partial turn when the adapter throws', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider
        {...createDefaultProps({ model, options: { onError: vi.fn() } })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('first');
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([
      { role: 'user', content: 'second' },
    ]);
  });

  it('drops an aborted turn so no unanswered tool call is replayed', async () => {
    const controller = new AbortController();
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(async () => {
        controller.abort();
        return {
          content: '',
          toolCalls: [{ id: 'call_1', name: 'increment', arguments: {} }],
        };
      })
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('first', { signal: controller.signal });
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([
      { role: 'user', content: 'second' },
    ]);
  });
});

describe('send() queue', () => {
  function sentMessages(model: ModelAdapter, callIndex: number) {
    return (model.sendMessage as ReturnType<typeof vi.fn>).mock.calls[
      callIndex
    ][0].messages;
  }

  function createGate() {
    let resolveGate = (): void => {};
    const gate = new Promise<void>((resolve) => {
      resolveGate = () => resolve();
    });
    return { gate, release: () => resolveGate() };
  }

  it('runs overlapping sends one at a time, each starting from the finished transcript', async () => {
    const model = createMockAdapter({ content: 'ok' });

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      await Promise.all([ctx!.send('one'), ctx!.send('two')]);
    });
    await act(async () => {
      await ctx!.send('three');
    });

    expect(sentMessages(model, 0)).toHaveLength(1);
    expect(sentMessages(model, 1)).toHaveLength(3);
    expect(sentMessages(model, 2)).toHaveLength(5);
    expect(ctx!.history.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('keeps isProcessing true until the last queued send settles', async () => {
    const { gate, release } = createGate();
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(async () => ({ content: 'first', toolCalls: [] }))
      .mockImplementationOnce(async () => {
        await gate;
        return { content: 'second', toolCalls: [] };
      });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let first: Promise<AgentResponse> | undefined;
    let second: Promise<AgentResponse> | undefined;
    await act(async () => {
      first = ctx!.send('one');
      second = ctx!.send('two');
      await first;
    });

    expect(ctx!.isProcessing).toBe(true);

    await act(async () => {
      release();
      await second;
    });

    expect(ctx!.isProcessing).toBe(false);
  });

  it('does not resurrect the transcript when clearHistory lands mid interaction', async () => {
    const { gate, release } = createGate();
    const sendMessage = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate;
        return { content: 'first', toolCalls: [] };
      })
      .mockImplementationOnce(async () => ({
        content: 'second',
        toolCalls: [],
      }));
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('first');
    });

    act(() => {
      ctx!.clearHistory();
    });

    await act(async () => {
      release();
      await pending;
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([
      { role: 'user', content: 'second' },
    ]);
  });

  it('leaves history empty and lastResponse null after a send resolves following a mid-flight clearHistory', async () => {
    const { gate, release } = createGate();
    const sendMessage = vi.fn().mockImplementationOnce(async () => {
      await gate;
      return { content: 'first', toolCalls: [] };
    });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    let response: AgentResponse | undefined;
    await act(async () => {
      pending = ctx!.send('first');
    });

    act(() => {
      ctx!.clearHistory();
    });

    await act(async () => {
      release();
      response = await pending;
    });

    expect(response!.message).toBe('first');
    expect(ctx!.history).toEqual([]);
    expect(ctx!.lastResponse).toBeNull();
  });

  it('maps a thrown AdapterError to ADAPTER_ERROR with its status', async () => {
    const onError = vi.fn();
    const model: ModelAdapter = {
      sendMessage: vi
        .fn()
        .mockRejectedValue(
          new AdapterError('Claude API error: 401', { status: 401 }),
        ),
    };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model, options: { onError } })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let response: AgentResponse | undefined;
    await act(async () => {
      response = await ctx!.send('hello');
    });

    expect(response!.error?.code).toBe('ADAPTER_ERROR');
    expect(response!.error?.status).toBe(401);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].code).toBe('ADAPTER_ERROR');
    expect(onError.mock.calls[0][0].status).toBe(401);
  });
});

describe('state as function', () => {
  it('accepts a getter function for state', () => {
    let captured: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps({ state: () => ({ count: 5 }) })}>
        <TestConsumer
          onContext={(c) => {
            captured = c;
          }}
        />
      </AIAgentProvider>,
    );

    expect(captured).toBeDefined();
  });
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('unmount abort', () => {
  it('unmounting mid model call ends a confirm-gated interaction as ABORTED, without calling onError, once the model resolves', async () => {
    const onError = vi.fn();
    const onConfirm = vi.fn(() => new Promise<boolean>(() => {}));
    const deferred = createDeferred<Partial<ModelResponse>>();
    const sendMessage = vi.fn().mockImplementationOnce(() => deferred.promise);
    const model: ModelAdapter = { sendMessage };
    const tools: ToolDefinition[] = [
      registerTool('clearCart', () => ({ cleared: true }), {
        description: 'Clear the cart',
        confirm: true,
      }),
    ];

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider
        {...createDefaultProps({
          model,
          tools,
          permissions: { canAccess: [], canExecute: ['clearCart'] },
          options: { onConfirm, onError },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('clear it');
    });

    unmount();

    let response: AgentResponse | undefined;
    await act(async () => {
      deferred.resolve({
        content: null,
        toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
      });
      response = await pending;
    });

    expect(response!.error?.code).toBe('ABORTED');
    expect(onError).not.toHaveBeenCalled();
    if (onConfirm.mock.calls.length > 0) {
      const passedSignal = (
        onConfirm.mock.calls[0][0] as { signal?: AbortSignal }
      ).signal;
      expect(passedSignal?.aborted).toBe(true);
    }
  });

  it('a send captured before unmount resolves ABORTED when invoked after, without calling the model or onError', async () => {
    const onError = vi.fn();
    const model = createMockAdapter({ content: 'ok' });

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider {...createDefaultProps({ model, options: { onError } })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    const send = ctx!.send;
    unmount();

    let response: AgentResponse | undefined;
    await act(async () => {
      response = await send('hello');
    });

    expect(response!.error?.code).toBe('ABORTED');
    expect(model.sendMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('a send after mount completes normally under StrictMode, so the simulated unmount does not poison later sends', async () => {
    const model = createMockAdapter({ content: 'ok' });

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <React.StrictMode>
        <AIAgentProvider {...createDefaultProps({ model })}>
          <TestConsumer
            onContext={(c) => {
              ctx = c;
            }}
          />
        </AIAgentProvider>
      </React.StrictMode>,
    );

    let response: AgentResponse | undefined;
    await act(async () => {
      response = await ctx!.send('hello');
    });

    expect(response!.message).toBe('ok');
    expect(model.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('aborting through sendOptions.signal mid model call settles ABORTED and isProcessing returns to false', async () => {
    const controller = new AbortController();
    const deferred = createDeferred<Partial<ModelResponse>>();
    const sendMessage = vi.fn().mockImplementationOnce(() => deferred.promise);
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('hello', { signal: controller.signal });
    });

    expect(ctx!.isProcessing).toBe(true);

    let response: AgentResponse | undefined;
    await act(async () => {
      controller.abort();
      deferred.resolve({ content: 'too late', toolCalls: [] });
      response = await pending;
    });

    expect(response!.error?.code).toBe('ABORTED');
    expect(ctx!.isProcessing).toBe(false);
  });

  /**
   * Races a pending send against a short timer instead of awaiting it bare,
   * so a regression that parks the interaction fails this assertion rather
   * than hanging the whole suite.
   */
  async function raceAgainstTimeout<T>(
    pending: Promise<T>,
  ): Promise<{ settled: boolean; value?: T }> {
    let settled = false;
    let value: T | undefined;
    pending.then((v) => {
      settled = true;
      value = v;
    });

    await act(async () => {
      await Promise.race([
        pending,
        new Promise<void>((resolve) => setTimeout(resolve, 300)),
      ]);
      // Give the microtask that flips `settled` a turn to run even when the
      // timer, not `pending`, is the one that wins the race above.
      await Promise.resolve();
      await Promise.resolve();
    });

    return { settled, value };
  }

  it('unmounting while a never-settling onConfirm is pending still resolves send as ABORTED, without calling onError, and records the call cancelled', async () => {
    const onError = vi.fn();
    // Shaped like every confirmation modal written before 0.3.0: it never
    // reads context.signal and never settles once the UI it belonged to is
    // gone.
    const onConfirm = vi.fn(() => new Promise<boolean>(() => {}));
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
      }),
    };
    const tools: ToolDefinition[] = [
      registerTool('clearCart', () => ({ cleared: true }), {
        description: 'Clear the cart',
        confirm: true,
      }),
    ];

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider
        {...createDefaultProps({
          model,
          tools,
          permissions: { canAccess: [], canExecute: ['clearCart'] },
          options: { onConfirm, onError },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('clear it');
    });

    expect(onConfirm).toHaveBeenCalledOnce();

    unmount();

    const { settled, value: response } = await raceAgainstTimeout(pending!);

    expect(settled).toBe(true);
    expect(response!.error?.code).toBe('ABORTED');
    expect(onError).not.toHaveBeenCalled();
    const lastCall = response!.toolCalls[response!.toolCalls.length - 1];
    expect(lastCall.status).toBe('cancelled');
  });

  it('a second send queued behind a parked onConfirm interaction still drains once unmount aborts it', async () => {
    const onConfirm = vi.fn(() => new Promise<boolean>(() => {}));
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
      }),
    };
    const tools: ToolDefinition[] = [
      registerTool('clearCart', () => ({ cleared: true }), {
        description: 'Clear the cart',
        confirm: true,
      }),
    ];

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider
        {...createDefaultProps({
          model,
          tools,
          permissions: { canAccess: [], canExecute: ['clearCart'] },
          options: { onConfirm },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let firstPending: Promise<AgentResponse> | undefined;
    let secondPending: Promise<AgentResponse> | undefined;
    await act(async () => {
      firstPending = ctx!.send('clear it');
      secondPending = ctx!.send('clear it again');
    });

    expect(onConfirm).toHaveBeenCalledOnce();

    unmount();

    const first = await raceAgainstTimeout(firstPending!);
    const second = await raceAgainstTimeout(secondPending!);

    expect(first.settled).toBe(true);
    expect(first.value!.error?.code).toBe('ABORTED');
    expect(second.settled).toBe(true);
    expect(second.value!.error?.code).toBe('ABORTED');
  });

  it('unmounting while a tool handler that ignores context.signal never settles still resolves send as ABORTED and records the call cancelled', async () => {
    const onError = vi.fn();
    const handler = vi.fn(() => new Promise<unknown>(() => {}));
    const model: ModelAdapter = {
      sendMessage: vi.fn().mockResolvedValue({
        content: null,
        toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
      }),
    };
    const tools: ToolDefinition[] = [
      registerTool('clearCart', handler, {
        description: 'Clear the cart',
      }),
    ];

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider
        {...createDefaultProps({
          model,
          tools,
          permissions: { canAccess: [], canExecute: ['clearCart'] },
          options: { onError },
        })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('clear it');
    });

    expect(handler).toHaveBeenCalledOnce();

    unmount();

    const { settled, value: response } = await raceAgainstTimeout(pending!);

    expect(settled).toBe(true);
    expect(response!.error?.code).toBe('ABORTED');
    const lastCall = response!.toolCalls[response!.toolCalls.length - 1];
    expect(lastCall.status).toBe('cancelled');
  });

  it('unmounting while the model adapter never settles and ignores the signal still resolves send as ABORTED with no tool calls', async () => {
    const sendMessage = vi.fn(() => new Promise<ModelResponse>(() => {}));
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { unmount } = render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('hello');
    });

    expect(sendMessage).toHaveBeenCalledOnce();

    unmount();

    const { settled, value: response } = await raceAgainstTimeout(pending!);

    expect(settled).toBe(true);
    expect(response!.error?.code).toBe('ABORTED');
    expect(response!.toolCalls).toEqual([]);
  });
});

describe('pinned options per interaction', () => {
  it('reports a failure to the onError captured at interaction start, not one from a re-render mid interaction', async () => {
    const onErrorA = vi.fn();
    const onErrorB = vi.fn();
    const deferred = createDeferred<Partial<ModelResponse>>();
    const sendMessage = vi.fn().mockImplementationOnce(() => deferred.promise);
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    const { rerender } = render(
      <AIAgentProvider
        {...createDefaultProps({ model, options: { onError: onErrorA } })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    let pending: Promise<AgentResponse> | undefined;
    await act(async () => {
      pending = ctx!.send('hello');
    });

    rerender(
      <AIAgentProvider
        {...createDefaultProps({ model, options: { onError: onErrorB } })}
      >
        <TestConsumer
          onContext={(c) => {
            ctx = c;
          }}
        />
      </AIAgentProvider>,
    );

    await act(async () => {
      deferred.reject(new Error('network down'));
      await pending;
    });

    expect(onErrorA).toHaveBeenCalledTimes(1);
    expect(onErrorA.mock.calls[0][0].message).toBe('network down');
    expect(onErrorB).not.toHaveBeenCalled();
  });
});
