import { describe, expect, it, vi } from 'vitest';
import { executeAgentLoop } from './executeAgentLoop';
import { registerTool } from '../tools/registerTool';
import type { ModelAdapter, ModelResponse, ToolDefinition } from '../types';

function mockAdapter(...responses: Partial<ModelResponse>[]): ModelAdapter {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      content: r.content ?? null,
      toolCalls: r.toolCalls,
      usage: r.usage,
    });
  }
  return { sendMessage: fn };
}

function defaultTools(): ToolDefinition[] {
  return [
    registerTool('addToCart', (args: unknown) => ({ added: args }), {
      description: 'Add item to cart',
      parameters: { type: 'object', properties: { productId: { type: 'string' } } },
    }),
    registerTool('clearCart', () => ({ cleared: true }), {
      description: 'Clear all cart items',
      parameters: { type: 'object', properties: {} },
      confirm: true,
    }),
  ];
}

const defaultPermissions = {
  canAccess: ['cart'],
  canExecute: ['addToCart', 'clearCart'],
};

describe('executeAgentLoop', () => {
  it('returns text response when LLM responds with text only', async () => {
    const adapter = mockAdapter({ content: 'You have 2 items in your cart.' });

    const result = await executeAgentLoop('What is in my cart?', {
      model: adapter,
      state: { cart: ['item1', 'item2'] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('You have 2 items in your cart.');
    expect(result.toolCalls).toEqual([]);
  });

  it('executes tool call and feeds result back to LLM', async () => {
    const adapter = mockAdapter(
      // First: LLM requests tool call
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'addToCart', arguments: { productId: 'abc' } }],
      },
      // Second: LLM responds with text after seeing tool result
      { content: 'Added to cart!' },
    );

    const result = await executeAgentLoop('Add the sneakers', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('Added to cart!');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('addToCart');
    expect(result.toolCalls[0].status).toBe('success');
    expect(result.toolCalls[0].result).toEqual({ added: { productId: 'abc' } });

    // Verify LLM was called twice (initial + after tool result)
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('supports multi-turn tool calling', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'addToCart', arguments: { productId: 'a' } }],
      },
      {
        content: null,
        toolCalls: [{ id: 'call_2', name: 'addToCart', arguments: { productId: 'b' } }],
      },
      { content: 'Both added!' },
    );

    const result = await executeAgentLoop('Add both items', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('Both added!');
    expect(result.toolCalls).toHaveLength(2);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('enforces maxTurns limit', async () => {
    // LLM always returns tool calls — should stop after maxTurns
    const adapter = mockAdapter(
      ...Array.from({ length: 10 }, () => ({
        content: null,
        toolCalls: [{ id: 'call_x', name: 'addToCart', arguments: { productId: 'x' } }],
      })),
    );

    const result = await executeAgentLoop('Keep adding', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { maxTurns: 3 },
      conversationHistory: [],
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toHaveLength(3);
    expect(result.message).toBe('');
  });

  it('rejects tool calls for tools not in canExecute', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'deleteAccount', arguments: {} }],
      },
      { content: 'Sorry, I cannot do that.' },
    );

    const result = await executeAgentLoop('Delete my account', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('denied');
    expect(result.toolCalls[0].toolName).toBe('deleteAccount');
  });

  it('executes confirmed tool when onConfirm returns true', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'clearCart', arguments: {} }],
      },
      { content: 'Cart cleared!' },
    );

    const onConfirm = vi.fn().mockResolvedValue(true);

    const result = await executeAgentLoop('Clear my cart', {
      model: adapter,
      state: { cart: ['item'] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onConfirm },
      conversationHistory: [],
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledWith({
      toolName: 'clearCart',
      args: {},
      description: 'Clear all cart items',
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('confirmed');
    expect(result.message).toBe('Cart cleared!');
  });

  it('cancels confirmed tool when onConfirm returns false', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'clearCart', arguments: {} }],
      },
      { content: 'Okay, cart not cleared.' },
    );

    const onConfirm = vi.fn().mockResolvedValue(false);

    const result = await executeAgentLoop('Clear my cart', {
      model: adapter,
      state: { cart: ['item'] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onConfirm },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('cancelled');
    expect(result.toolCalls[0].result).toBe('Tool execution cancelled by user');
  });

  it('cancels confirmed tool with warning when no onConfirm provided', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'clearCart', arguments: {} }],
      },
      { content: 'Cannot clear without confirmation.' },
    );

    const result = await executeAgentLoop('Clear my cart', {
      model: adapter,
      state: { cart: ['item'] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { debug: true },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('cancelled');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('requires confirmation but no onConfirm handler'),
    );

    warnSpy.mockRestore();
  });

  it('calls onToolCall callback for each tool execution', async () => {
    const onToolCall = vi.fn();
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'addToCart', arguments: { productId: 'x' } }],
      },
      { content: 'Done!' },
    );

    await executeAgentLoop('Add item', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onToolCall },
      conversationHistory: [],
    });

    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith({
      toolName: 'addToCart',
      args: { productId: 'x' },
      result: { added: { productId: 'x' } },
      status: 'success',
    });
  });

  it('handles tool handler errors gracefully', async () => {
    const failingTool = registerTool('failTool', () => { throw new Error('Tool broke'); }, {
      description: 'A tool that fails',
      parameters: { type: 'object' },
    });

    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'failTool', arguments: {} }],
      },
      { content: 'Something went wrong.' },
    );

    const result = await executeAgentLoop('Run failing tool', {
      model: adapter,
      state: {},
      tools: [failingTool],
      permissions: { canAccess: [], canExecute: ['failTool'] },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('error');
    expect(result.toolCalls[0].result).toBe('Tool broke');
  });

  it('filters state by canAccess before sending to LLM', async () => {
    const adapter = mockAdapter({ content: 'hello' });

    await executeAgentLoop('Hello', {
      model: adapter,
      state: { cart: ['item'], secret: 'hidden' },
      tools: defaultTools(),
      permissions: { canAccess: ['cart'], canExecute: ['addToCart'] },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.state).toEqual({ cart: ['item'] });
    expect('secret' in callArgs.state).toBe(false);
  });

  it('includes systemPrompt in LLM request', async () => {
    const adapter = mockAdapter({ content: 'hello' });

    await executeAgentLoop('Hi', {
      model: adapter,
      state: {},
      tools: [],
      permissions: { canAccess: [], canExecute: [] },
      options: { systemPrompt: 'You are a test assistant.' },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.systemPrompt).toBe('You are a test assistant.');
  });

  it('uses state getter function', async () => {
    const adapter = mockAdapter({ content: 'Got it' });
    const getter = () => ({ count: 42 });

    await executeAgentLoop('Check count', {
      model: adapter,
      state: getter,
      tools: [],
      permissions: { canAccess: ['count'], canExecute: [] },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.state).toEqual({ count: 42 });
  });
});
