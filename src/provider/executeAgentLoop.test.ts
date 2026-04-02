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

  it('sends empty state object to LLM (pull-based)', async () => {
    const adapter = mockAdapter({ content: 'hello' });

    await executeAgentLoop('Hello', {
      model: adapter,
      state: { cart: ['item'], secret: 'hidden' },
      tools: defaultTools(),
      permissions: { canAccess: ['cart'], canExecute: ['addToCart'] },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.state).toEqual({});
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
    expect(callArgs.systemPrompt).toContain('You are a test assistant.');
  });

  it('includes stateManifest in LLM request', async () => {
    const adapter = mockAdapter({ content: 'Got it' });

    await executeAgentLoop('Check count', {
      model: adapter,
      state: () => ({ count: 42 }),
      tools: [],
      permissions: { canAccess: ['count'], canExecute: [] },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.stateManifest).toEqual([{ key: 'count', description: 'count' }]);
    expect(callArgs.state).toEqual({});
  });

  it('handles __readState tool call and returns requested state', async () => {
    const adapter = mockAdapter(
      // LLM calls readState to get cart
      {
        content: null,
        toolCalls: [{ id: 'rs_1', name: '__readState', arguments: { keys: ['cart'] } }],
      },
      // LLM responds with text after reading state
      { content: 'You have 2 items.' },
    );

    const result = await executeAgentLoop('What is in my cart?', {
      model: adapter,
      state: { cart: ['item1', 'item2'], secret: 'hidden' },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('You have 2 items.');
    // readState is internal — not in toolCalls
    expect(result.toolCalls).toEqual([]);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);

    // Verify the tool result message sent back to LLM
    const secondCall = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string; toolCallId?: string }) => m.role === 'tool' && m.toolCallId === 'rs_1',
    );
    expect(JSON.parse(toolMsg.content)).toEqual({ cart: ['item1', 'item2'] });
  });

  it('readState filters out keys not in canAccess', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [
          { id: 'rs_1', name: '__readState', arguments: { keys: ['cart', 'secret'] } },
        ],
      },
      { content: 'Only cart returned.' },
    );

    await executeAgentLoop('Show me everything', {
      model: adapter,
      state: { cart: ['item'], secret: 'x' },
      tools: defaultTools(),
      permissions: { canAccess: ['cart'], canExecute: ['addToCart'] },
      conversationHistory: [],
    });

    const secondCall = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const toolMsg = secondCall.messages.find(
      (m: { role: string; toolCallId?: string }) => m.role === 'tool' && m.toolCallId === 'rs_1',
    );
    const parsed = JSON.parse(toolMsg.content);
    expect(parsed).toEqual({ cart: ['item'] });
    expect('secret' in parsed).toBe(false);
  });

  it('readState followed by tool call works in multi-turn', async () => {
    const adapter = mockAdapter(
      // Turn 1: read state
      {
        content: null,
        toolCalls: [{ id: 'rs_1', name: '__readState', arguments: { keys: ['cart'] } }],
      },
      // Turn 2: execute a tool
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'addToCart', arguments: { productId: 'abc' } }],
      },
      // Turn 3: final response
      { content: 'Added to cart!' },
    );

    const result = await executeAgentLoop('Add sneakers', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('Added to cart!');
    // Only the real tool call, not readState
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].toolName).toBe('addToCart');
    expect(adapter.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('includes __readState tool in LLM tools when canAccess has keys', async () => {
    const adapter = mockAdapter({ content: 'hello' });

    await executeAgentLoop('Hi', {
      model: adapter,
      state: { count: 1 },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('__readState');
  });

  it('does not include __readState when canAccess is empty', async () => {
    const adapter = mockAdapter({ content: 'hello' });

    await executeAgentLoop('Hi', {
      model: adapter,
      state: {},
      tools: [],
      permissions: { canAccess: [], canExecute: [] },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const toolNames = callArgs.tools.map((t: { name: string }) => t.name);
    expect(toolNames).not.toContain('__readState');
  });

  it('uses stateDescriptions in manifest', async () => {
    const adapter = mockAdapter({ content: 'Got it' });

    await executeAgentLoop('Check', {
      model: adapter,
      state: { user: { name: 'Alice' }, cart: [] },
      tools: [],
      permissions: {
        canAccess: ['user', 'cart'],
        canExecute: [],
        stateDescriptions: {
          user: 'Current logged-in user profile',
          cart: 'Shopping cart contents',
        },
      },
      conversationHistory: [],
    });

    const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.stateManifest).toEqual([
      { key: 'user', description: 'Current logged-in user profile' },
      { key: 'cart', description: 'Shopping cart contents' },
    ]);
    // Manifest prompt should be injected into systemPrompt
    expect(callArgs.systemPrompt).toContain('Current logged-in user profile');
    expect(callArgs.systemPrompt).toContain('__readState');
  });
});
