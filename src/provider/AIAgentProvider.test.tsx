import { describe, expect, it, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { AIAgentProvider } from './AIAgentProvider';
import { useAgent } from './useAgent';
import { registerTool } from '../tools/registerTool';
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

describe('state as function', () => {
  it('accepts a getter function for state', () => {
    let captured: ReturnType<typeof useAgent> | undefined;

    render(
      <AIAgentProvider {...createDefaultProps({ state: () => ({ count: 5 }) })}>
        <TestConsumer onContext={(c) => { captured = c; }} />
      </AIAgentProvider>,
    );

    expect(captured).toBeDefined();
    // Provider renders without error with function state
  });
});
