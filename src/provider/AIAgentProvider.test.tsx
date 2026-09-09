import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { AIAgentProvider } from './AIAgentProvider';
import { useAgent } from './useAgent';
import { registerTool } from '../tools/registerTool';
import { AdapterError } from '../adapters/AdapterError';
import type { AgentResponse, ModelAdapter, ModelResponse, PermissionsConfig, ToolDefinition } from '../types';

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

function createDefaultProps(overrides: Partial<Parameters<typeof AIAgentProvider>[0]> = {}) {
  return {
    model: createMockAdapter(),
    state: { count: 0 },
    tools: [registerTool('increment', () => {})],
    permissions: defaultPermissions,
    ...overrides,
  };
}

function TestConsumer({ onContext }: { onContext: (ctx: ReturnType<typeof useAgent>) => void }) {
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
        <TestConsumer onContext={(ctx) => { captured = ctx; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('hello');
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toBe('network down');
  });
});

describe('conversation replay', () => {
  function sentMessages(model: ModelAdapter, callIndex: number) {
    return (model.sendMessage as ReturnType<typeof vi.fn>).mock.calls[callIndex][0].messages;
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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

    const toolResult = replayed.find((m: { role: string }) => m.role === 'tool');
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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

    expect(sentMessages(model, 1)).toEqual([{ role: 'user', content: 'second' }]);
  });

  it('drops the partial turn when the adapter throws', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ content: 'ok', toolCalls: [] });
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model, options: { onError: vi.fn() } })}>
        <TestConsumer onContext={(c) => { ctx = c; }} />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('first');
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([{ role: 'user', content: 'second' }]);
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
      </AIAgentProvider>,
    );

    await act(async () => {
      await ctx!.send('first', { signal: controller.signal });
    });
    await act(async () => {
      await ctx!.send('second');
    });

    expect(sentMessages(model, 1)).toEqual([{ role: 'user', content: 'second' }]);
  });
});

describe('send() queue', () => {
  function sentMessages(model: ModelAdapter, callIndex: number) {
    return (model.sendMessage as ReturnType<typeof vi.fn>).mock.calls[callIndex][0].messages;
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
      .mockImplementationOnce(async () => ({ content: 'second', toolCalls: [] }));
    const model: ModelAdapter = { sendMessage };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model })}>
        <TestConsumer onContext={(c) => { ctx = c; }} />
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

    expect(sentMessages(model, 1)).toEqual([{ role: 'user', content: 'second' }]);
  });

  it('maps a thrown AdapterError to ADAPTER_ERROR with its status', async () => {
    const onError = vi.fn();
    const model: ModelAdapter = {
      sendMessage: vi
        .fn()
        .mockRejectedValue(new AdapterError('Claude API error: 401', { status: 401 })),
    };

    let ctx: ReturnType<typeof useAgent> | undefined;
    render(
      <AIAgentProvider {...createDefaultProps({ model, options: { onError } })}>
        <TestConsumer onContext={(c) => { ctx = c; }} />
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
        <TestConsumer onContext={(c) => { captured = c; }} />
      </AIAgentProvider>,
    );

    expect(captured).toBeDefined();
  });
});
