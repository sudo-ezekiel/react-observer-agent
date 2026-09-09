import { describe, expect, it, vi } from 'vitest';
import { executeAgentLoop } from './executeAgentLoop';
import { registerTool } from '../tools/registerTool';
import type {
  AgentEvent,
  ModelAdapter,
  ModelResponse,
  StandardSchemaV1,
  ToolDefinition,
} from '../types';

function mockAdapter(...responses: Partial<ModelResponse>[]): ModelAdapter {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      content: r.content ?? null,
      toolCalls: r.toolCalls,
      usage: r.usage,
      stopReason: r.stopReason,
      providerData: r.providerData,
    });
  }
  return { sendMessage: fn };
}

/** Most tests assert on the response alone, not the replay transcript. */
async function runLoop(
  message: string,
  ctx: Parameters<typeof executeAgentLoop>[1],
) {
  const { response } = await executeAgentLoop(message, ctx);
  return response;
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

    const result = await runLoop('What is in my cart?', {
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

    const result = await runLoop('Add the sneakers', {
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

    const result = await runLoop('Add both items', {
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
    // The model never stops calling tools, so the turn budget is what ends it.
    const adapter = mockAdapter(
      ...Array.from({ length: 10 }, () => ({
        content: null,
        toolCalls: [{ id: 'call_x', name: 'addToCart', arguments: { productId: 'x' } }],
      })),
    );

    const result = await runLoop('Keep adding', {
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

  it('reports a MAX_TURNS error when the turn budget runs out', async () => {
    const adapter = mockAdapter(
      ...Array.from({ length: 10 }, () => ({
        content: null,
        toolCalls: [{ id: 'call_x', name: 'addToCart', arguments: { productId: 'x' } }],
      })),
    );

    const result = await runLoop('Keep adding', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { maxTurns: 2 },
      conversationHistory: [],
    });

    expect(result.error?.code).toBe('MAX_TURNS');
    expect(result.error?.message).toContain('within 2 turns');
    expect(result.message).toBe('');
    // Work completed before the budget ran out is still reported.
    expect(result.toolCalls).toHaveLength(2);
  });

  it('does not set an error when the agent answers within the budget', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'addToCart', arguments: { productId: 'a' } }],
      },
      { content: 'Added.' },
    );

    const result = await runLoop('Add it', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { maxTurns: 5 },
      conversationHistory: [],
    });

    expect(result.error).toBeUndefined();
    expect(result.message).toBe('Added.');
  });

  it('treats a deliberately empty final answer as success, not exhaustion', async () => {
    const adapter = mockAdapter({ content: '' });

    const result = await runLoop('hi', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.error).toBeUndefined();
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

    const result = await runLoop('Delete my account', {
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

    const result = await runLoop('Clear my cart', {
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

    const result = await runLoop('Clear my cart', {
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

    const result = await runLoop('Clear my cart', {
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

    await runLoop('Add item', {
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

    const result = await runLoop('Run failing tool', {
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

    await runLoop('Hello', {
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

    await runLoop('Hi', {
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

    await runLoop('Check count', {
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

    const result = await runLoop('What is in my cart?', {
      model: adapter,
      state: { cart: ['item1', 'item2'], secret: 'hidden' },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(result.message).toBe('You have 2 items.');
    // readState is internal, so it stays out of toolCalls.
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

    await runLoop('Show me everything', {
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

    const result = await runLoop('Add sneakers', {
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

    await runLoop('Hi', {
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

    await runLoop('Hi', {
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

    await runLoop('Check', {
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

  describe('usage', () => {
    it('totals usage across every turn of an interaction', async () => {
      const adapter = mockAdapter(
        {
          content: null,
          toolCalls: [{ id: 'c1', name: 'addToCart', arguments: { productId: 'a' } }],
          usage: { promptTokens: 100, completionTokens: 20 },
        },
        { content: 'Added.', usage: { promptTokens: 150, completionTokens: 10 } },
      );

      const result = await runLoop('add it', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        conversationHistory: [],
      });

      expect(result.usage).toEqual({ promptTokens: 250, completionTokens: 30 });
    });

    it('leaves usage undefined when no adapter response reports it', async () => {
      const adapter = mockAdapter({ content: 'hi' });

      const result = await runLoop('hello', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        conversationHistory: [],
      });

      expect(result.usage).toBeUndefined();
    });

    it('reports usage spent before the turn budget ran out', async () => {
      const adapter = mockAdapter(
        ...Array.from({ length: 5 }, () => ({
          content: null,
          toolCalls: [{ id: 'c', name: 'addToCart', arguments: { productId: 'x' } }],
          usage: { promptTokens: 10, completionTokens: 5 },
        })),
      );

      const result = await runLoop('keep going', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        options: { maxTurns: 2 },
        conversationHistory: [],
      });

      expect(result.error?.code).toBe('MAX_TURNS');
      expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 10 });
    });
  });

  describe('abort', () => {
    it('returns an ABORTED error without calling the adapter when already aborted', async () => {
      const adapter = mockAdapter({ content: 'never reached' });
      const controller = new AbortController();
      controller.abort();

      const result = await runLoop('hello', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        conversationHistory: [],
        signal: controller.signal,
      });

      expect(result.error?.code).toBe('ABORTED');
      expect(result.message).toBe('');
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it('forwards the signal to the adapter', async () => {
      const adapter = mockAdapter({ content: 'hi' });
      const controller = new AbortController();

      await runLoop('hello', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        conversationHistory: [],
        signal: controller.signal,
      });

      const request = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(request.signal).toBe(controller.signal);
    });

    it('converts an adapter AbortError into an ABORTED response', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      const adapter: ModelAdapter = {
        sendMessage: vi.fn().mockRejectedValue(abortError),
      };

      const result = await runLoop('hello', {
        model: adapter,
        state: {},
        tools: defaultTools(),
        permissions: defaultPermissions,
        conversationHistory: [],
      });

      expect(result.error?.code).toBe('ABORTED');
    });

    it('stops before running tools when aborted mid-interaction', async () => {
      const controller = new AbortController();
      const handler = vi.fn(() => ({ ok: true }));
      const adapter: ModelAdapter = {
        sendMessage: vi.fn().mockImplementation(async () => {
          // The consumer cancels while the model call is in flight.
          controller.abort();
          return {
            content: null,
            toolCalls: [{ id: 'c1', name: 'addToCart', arguments: { productId: 'x' } }],
          };
        }),
      };

      const result = await runLoop('add it', {
        model: adapter,
        state: {},
        tools: [
          registerTool('addToCart', handler, {
            description: 'Add item to cart',
            parameters: { type: 'object', properties: {} },
          }),
        ],
        permissions: { canAccess: [], canExecute: ['addToCart'] },
        conversationHistory: [],
        signal: controller.signal,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(result.error?.code).toBe('ABORTED');
    });

    it('still rethrows genuine adapter failures', async () => {
      const adapter: ModelAdapter = {
        sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
      };

      await expect(
        runLoop('hello', {
          model: adapter,
          state: {},
          tools: defaultTools(),
          permissions: defaultPermissions,
          conversationHistory: [],
        }),
      ).rejects.toThrow('boom');
    });
  });

  describe('argument validation', () => {
    it('rejects a call with missing required arguments without running the handler', async () => {
      const handler = vi.fn();
      const tools = [
        registerTool('addToCart', handler, {
          description: 'Add item to cart',
          parameters: {
            type: 'object',
            properties: { productId: { type: 'string' } },
            required: ['productId'],
          },
        }),
      ];
      const adapter = mockAdapter(
        { content: null, toolCalls: [{ id: 'c1', name: 'addToCart', arguments: {} }] },
        { content: 'Sorry, I need a product id.' },
      );

      const result = await runLoop('add something', {
        model: adapter,
        state: {},
        tools,
        permissions: { canAccess: [], canExecute: ['addToCart'] },
        conversationHistory: [],
      });

      expect(handler).not.toHaveBeenCalled();
      expect(result.toolCalls[0].status).toBe('error');
      expect(result.toolCalls[0].result).toContain('productId is required');
    });

    it('feeds the validation error back so the model can retry', async () => {
      const handler = vi.fn(() => ({ ok: true }));
      const tools = [
        registerTool('addToCart', handler, {
          description: 'Add item to cart',
          parameters: {
            type: 'object',
            properties: { productId: { type: 'string' } },
            required: ['productId'],
          },
        }),
      ];
      const adapter = mockAdapter(
        { content: null, toolCalls: [{ id: 'c1', name: 'addToCart', arguments: {} }] },
        {
          content: null,
          toolCalls: [{ id: 'c2', name: 'addToCart', arguments: { productId: 'p1' } }],
        },
        { content: 'Added.' },
      );

      const result = await runLoop('add something', {
        model: adapter,
        state: {},
        tools,
        permissions: { canAccess: [], canExecute: ['addToCart'] },
        conversationHistory: [],
      });

      const secondRequest = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
      const toolMessage = secondRequest.messages.find(
        (m: { role: string }) => m.role === 'tool',
      );
      expect(JSON.parse(toolMessage.content).error).toContain('productId is required');

      expect(handler).toHaveBeenCalledOnce();
      expect(result.message).toBe('Added.');
      expect(result.toolCalls.map((c) => c.status)).toEqual(['error', 'success']);
    });

    it('does not ask for confirmation on an invalid call', async () => {
      const onConfirm = vi.fn().mockResolvedValue(true);
      const handler = vi.fn();
      const tools = [
        registerTool('clearCart', handler, {
          description: 'Clear the cart',
          parameters: {
            type: 'object',
            properties: { confirmToken: { type: 'string' } },
            required: ['confirmToken'],
          },
          confirm: true,
        }),
      ];
      const adapter = mockAdapter(
        { content: null, toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }] },
        { content: 'done' },
      );

      await runLoop('clear it', {
        model: adapter,
        state: {},
        tools,
        permissions: { canAccess: [], canExecute: ['clearCart'] },
        options: { onConfirm },
        conversationHistory: [],
      });

      expect(onConfirm).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it('skips validation for tools without a parameters schema', async () => {
      const handler = vi.fn(() => ({ ok: true }));
      const adapter = mockAdapter(
        {
          content: null,
          toolCalls: [{ id: 'c1', name: 'freeForm', arguments: { whatever: 1 } }],
        },
        { content: 'done' },
      );

      const result = await runLoop('go', {
        model: adapter,
        state: {},
        tools: [registerTool('freeForm', handler, { description: 'Anything goes' })],
        permissions: { canAccess: [], canExecute: ['freeForm'] },
        conversationHistory: [],
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(result.toolCalls[0].status).toBe('success');
    });
  });

  describe('tool visibility', () => {
    it('exposes a described tool without parameters using an empty object schema', async () => {
      const adapter = mockAdapter({ content: 'done' });
      const tools = [
        registerTool('clearCart', () => ({ cleared: true }), {
          description: 'Remove all items from the cart',
        }),
      ];

      await runLoop('clear it', {
        model: adapter,
        state: {},
        tools,
        permissions: { canAccess: [], canExecute: ['clearCart'] },
        conversationHistory: [],
      });

      const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.tools).toEqual([
        {
          name: 'clearCart',
          description: 'Remove all items from the cart',
          parameters: { type: 'object', properties: {} },
        },
      ]);
    });

    it('hides tools without a description and warns in debug mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const adapter = mockAdapter({ content: 'done' });
      const tools = [registerTool('mysteryTool', () => null)];

      await runLoop('hello', {
        model: adapter,
        state: {},
        tools,
        permissions: { canAccess: [], canExecute: ['mysteryTool'] },
        options: { debug: true },
        conversationHistory: [],
      });

      const callArgs = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(callArgs.tools).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('has no description and is hidden'),
      );

      warnSpy.mockRestore();
    });

    it('still executes a hidden tool when the LLM names it', async () => {
      const handler = vi.fn(() => ({ ok: true }));
      const adapter = mockAdapter(
        { content: null, toolCalls: [{ id: 'c1', name: 'mysteryTool', arguments: {} }] },
        { content: 'done' },
      );

      const result = await runLoop('hello', {
        model: adapter,
        state: {},
        tools: [registerTool('mysteryTool', handler)],
        permissions: { canAccess: [], canExecute: ['mysteryTool'] },
        conversationHistory: [],
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(result.toolCalls[0].status).toBe('success');
    });
  });
});

describe('executeAgentLoop state reads', () => {
  it('reports malformed __readState arguments instead of throwing', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        // A model that sends `keys` as a bare string used to crash the loop.
        toolCalls: [{ id: 'rs_1', name: '__readState', arguments: { keys: 'cart' } }],
      },
      { content: 'Let me try again.' },
    );

    const { response, messages } = await executeAgentLoop('what is in my cart', {
      model: adapter,
      state: { cart: ['item'] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    expect(response.error).toBeUndefined();
    expect(response.message).toBe('Let me try again.');
    // Nothing about an internal read reaches the caller.
    expect(response.toolCalls).toEqual([]);

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content).error).toContain(
      'Invalid arguments for __readState',
    );
    expect(toolMessage!.isError).toBe(true);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('truncates a state value over maxStateBytes and leaves small ones alone', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [
          { id: 'rs_1', name: '__readState', arguments: { keys: ['big', 'small'] } },
        ],
      },
      { content: 'read it' },
    );

    await runLoop('read state', {
      model: adapter,
      state: { big: 'x'.repeat(500), small: 'ok' },
      tools: [],
      permissions: { canAccess: ['big', 'small'], canExecute: [] },
      options: { maxStateBytes: 50 },
      conversationHistory: [],
    });

    const secondCall = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const toolMsg = secondCall.messages.find((m: { role: string }) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg.content);

    expect(parsed.small).toBe('ok');
    expect(parsed.big.__truncated).toBe(true);
    expect(parsed.big.limit).toBe(50);
    // The 500 characters plus the two quotes JSON adds.
    expect(parsed.big.bytes).toBe(502);
    expect(parsed.big.preview).toHaveLength(50);
  });
});

describe('executeAgentLoop events', () => {
  function collect(): { events: AgentEvent[]; onEvent: (e: AgentEvent) => void } {
    const events: AgentEvent[] = [];
    return { events, onEvent: (e) => events.push(e) };
  }

  it('emits turn, state read and tool events in execution order', async () => {
    const { events, onEvent } = collect();
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'rs_1', name: '__readState', arguments: { keys: ['cart'] } }],
      },
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'addToCart', arguments: { productId: 'a' } }],
      },
      { content: 'Added.' },
    );

    await runLoop('add it', {
      model: adapter,
      state: { cart: [] },
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onEvent },
      conversationHistory: [],
    });

    expect(events.map((e) => e.type)).toEqual([
      'turn_start',
      'state_read',
      'turn_start',
      'tool_start',
      'tool_end',
      'turn_start',
    ]);
    expect(events[0]).toEqual({ type: 'turn_start', turn: 1, maxTurns: 5 });
    expect(events[1]).toEqual({
      type: 'state_read',
      requested: ['cart'],
      keys: ['cart'],
    });
    expect(events[4]).toEqual({
      type: 'tool_end',
      toolName: 'addToCart',
      args: { productId: 'a' },
      result: { added: { productId: 'a' } },
      status: 'success',
    });
  });

  it('reports the keys a state read was denied through the state_read event', async () => {
    const { events, onEvent } = collect();
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [
          { id: 'rs_1', name: '__readState', arguments: { keys: ['cart', 'secret'] } },
        ],
      },
      { content: 'done' },
    );

    await runLoop('read', {
      model: adapter,
      state: { cart: [], secret: 'x' },
      tools: [],
      permissions: { canAccess: ['cart'], canExecute: [] },
      options: { onEvent },
      conversationHistory: [],
    });

    expect(events.find((e) => e.type === 'state_read')).toEqual({
      type: 'state_read',
      requested: ['cart', 'secret'],
      keys: ['cart'],
    });
  });

  it('pairs a tool_start with a tool_end for a denied tool', async () => {
    const { events, onEvent } = collect();
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'deleteAccount', arguments: {} }] },
      { content: 'Cannot do that.' },
    );

    await runLoop('delete it', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onEvent },
      conversationHistory: [],
    });

    const toolEvents = events.filter((e) => e.type !== 'turn_start');
    expect(toolEvents.map((e) => e.type)).toEqual(['tool_start', 'tool_end']);
    expect(toolEvents[1]).toMatchObject({ toolName: 'deleteAccount', status: 'denied' });
  });

  it('reports a permitted name with no definition through onToolCall', async () => {
    const onToolCall = vi.fn();
    const { events, onEvent } = collect();
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'ghostTool', arguments: {} }] },
      { content: 'That tool is missing.' },
    );

    const result = await runLoop('run the ghost', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      // Permitted by name, but never registered.
      permissions: { canAccess: [], canExecute: ['ghostTool'] },
      options: { onToolCall, onEvent },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('denied');
    expect(onToolCall).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledWith({
      toolName: 'ghostTool',
      args: {},
      result: 'Tool "ghostTool" not found',
      status: 'denied',
    });
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(1);
  });
});

describe('executeAgentLoop tool execution', () => {
  it('passes the interaction signal to the handler', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const controller = new AbortController();
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }] },
      { content: 'done' },
    );

    await runLoop('ping', {
      model: adapter,
      state: {},
      tools: [registerTool('ping', handler, { description: 'Ping' })],
      permissions: { canAccess: [], canExecute: ['ping'] },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(handler).toHaveBeenCalledOnce();
    const context = handler.mock.calls[0][1];
    expect(Object.keys(context)).toEqual(['signal']);
    expect(context.signal).toBe(controller.signal);
  });

  it('passes the signal to onConfirm', async () => {
    const controller = new AbortController();
    const onConfirm = vi.fn().mockResolvedValue(true);
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }] },
      { content: 'Cleared.' },
    );

    await runLoop('clear it', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onConfirm },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(onConfirm).toHaveBeenCalledOnce();
    const pending = onConfirm.mock.calls[0][0];
    expect(pending).toMatchObject({
      toolName: 'clearCart',
      args: {},
      description: 'Clear all cart items',
    });
    expect(pending.signal).toBe(controller.signal);
  });

  it('does not run the handler when the signal aborts while confirmation is pending', async () => {
    const controller = new AbortController();
    const handler = vi.fn(() => ({ cleared: true }));
    const onConfirm = vi.fn(async () => {
      // The interaction is cancelled underneath a prompt the user still answers.
      controller.abort();
      return true;
    });
    const adapter = mockAdapter({
      content: null,
      toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
    });

    const { response, messages } = await executeAgentLoop('clear it', {
      model: adapter,
      state: {},
      tools: [
        registerTool('clearCart', handler, {
          description: 'Clear all cart items',
          confirm: true,
        }),
      ],
      permissions: { canAccess: [], canExecute: ['clearCart'] },
      options: { onConfirm },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(response.error?.code).toBe('ABORTED');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].status).toBe('cancelled');
    expect(response.toolCalls[0].result).toBe(
      'Tool execution cancelled: interaction aborted',
    );

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content)).toEqual({
      status: 'cancelled',
      reason: 'Interaction aborted',
    });
    expect(toolMessage!.isError).toBeUndefined();
  });

  it('records a non-serializable result once, as an error', async () => {
    const onToolCall = vi.fn();
    const handler = () => {
      const circular: Record<string, unknown> = { name: 'loop' };
      circular.self = circular;
      return circular;
    };
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'getCircular', arguments: {} }] },
      { content: 'That did not work.' },
    );

    const result = await runLoop('get it', {
      model: adapter,
      state: {},
      tools: [registerTool('getCircular', handler, { description: 'Returns a cycle' })],
      permissions: { canAccess: [], canExecute: ['getCircular'] },
      options: { onToolCall },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('error');
    expect(result.toolCalls[0].result).toContain('Tool result is not serializable');
    expect(onToolCall).toHaveBeenCalledOnce();
  });

  it('marks failure tool messages as errors and cancellations as not', async () => {
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [
          { id: 'c1', name: 'deleteAccount', arguments: {} },
          { id: 'c2', name: 'failTool', arguments: {} },
          { id: 'c3', name: 'clearCart', arguments: {} },
        ],
      },
      { content: 'done' },
    );

    const failTool = registerTool(
      'failTool',
      () => {
        throw new Error('Tool broke');
      },
      { description: 'A tool that fails' },
    );

    const { messages } = await executeAgentLoop('do everything', {
      model: adapter,
      state: {},
      tools: [...defaultTools(), failTool],
      permissions: { canAccess: [], canExecute: ['failTool', 'clearCart'] },
      options: { onConfirm: vi.fn().mockResolvedValue(false) },
      conversationHistory: [],
    });

    const byId = new Map(
      messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, m]),
    );
    expect(byId.get('c1')!.isError).toBe(true);
    expect(byId.get('c2')!.isError).toBe(true);
    expect(byId.get('c3')!.isError).toBeUndefined();
  });

  it('validates through a Standard Schema and hands the handler the parsed value', async () => {
    const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
          const input = value as { name?: unknown };
          if (typeof input?.name !== 'string') {
            return { issues: [{ message: 'expected a string', path: ['name'] }] };
          }
          return { value: { name: input.name.toUpperCase() } };
        },
      },
    };

    const handler = vi.fn((args: { name: string }) => ({ renamed: args.name }));
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'rename', arguments: { name: 'ada' } }],
      },
      { content: 'Renamed.' },
    );

    const result = await runLoop('rename it', {
      model: adapter,
      state: {},
      tools: [registerTool('rename', handler, { description: 'Rename', schema })],
      permissions: { canAccess: [], canExecute: ['rename'] },
      conversationHistory: [],
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0]).toEqual({ name: 'ADA' });
    expect(result.toolCalls[0].result).toEqual({ renamed: 'ADA' });
  });

  it('reports a Standard Schema issue with its path', async () => {
    const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          const input = value as { name?: unknown };
          if (typeof input?.name !== 'string') {
            return { issues: [{ message: 'expected a string', path: ['name'] }] };
          }
          return { value: { name: input.name } };
        },
      },
    };

    const handler = vi.fn();
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'rename', arguments: { name: 7 } }] },
      { content: 'Sorry.' },
    );

    const result = await runLoop('rename it', {
      model: adapter,
      state: {},
      tools: [registerTool('rename', handler, { description: 'Rename', schema })],
      permissions: { canAccess: [], canExecute: ['rename'] },
      conversationHistory: [],
    });

    expect(handler).not.toHaveBeenCalled();
    expect(result.toolCalls[0].status).toBe('error');
    expect(result.toolCalls[0].result).toContain('name: expected a string');
  });

  it('records onConfirm rejecting with an AbortError after abort as cancelled, not an error', async () => {
    const controller = new AbortController();
    const handler = vi.fn(() => ({ cleared: true }));
    const onConfirm = vi.fn(async () => {
      // The confirmation surface unmounts on cancel and its promise rejects.
      controller.abort();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const adapter = mockAdapter({
      content: null,
      toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }],
    });
    const events: AgentEvent[] = [];

    const { response, messages } = await executeAgentLoop('clear it', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onConfirm, onEvent: (e) => events.push(e) },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(response.error?.code).toBe('ABORTED');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].status).toBe('cancelled');
    expect(response.toolCalls[0].result).toBe(
      'Tool execution cancelled: interaction aborted',
    );
    expect(events.filter((e) => e.type === 'tool_end')).toHaveLength(1);

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content)).toEqual({
      status: 'cancelled',
      reason: 'Interaction aborted',
    });
    expect(toolMessage!.isError).toBeUndefined();
  });

  it('records onConfirm rejecting with a plain error as a tool error and continues the loop', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('confirmation UI crashed'));
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'clearCart', arguments: {} }] },
      { content: 'Handled it.' },
    );

    const result = await runLoop('clear it', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      options: { onConfirm },
      conversationHistory: [],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].status).toBe('error');
    expect(result.toolCalls[0].result).toBe('confirmation UI crashed');
    expect(result.message).toBe('Handled it.');
    expect(result.error).toBeUndefined();
  });

  it('propagates a throwing onToolCall callback without recording the call twice', async () => {
    const onToolCall = vi.fn(() => {
      throw new Error('callback exploded');
    });
    const handler = vi.fn(() => ({ ok: true }));
    const adapter = mockAdapter({
      content: null,
      toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
    });

    await expect(
      executeAgentLoop('ping', {
        model: adapter,
        state: {},
        tools: [registerTool('ping', handler, { description: 'Ping' })],
        permissions: { canAccess: [], canExecute: ['ping'] },
        options: { onToolCall },
        conversationHistory: [],
      }),
    ).rejects.toThrow('callback exploded');

    expect(handler).toHaveBeenCalledOnce();
    expect(onToolCall).toHaveBeenCalledOnce();
  });

  it('cancels when the abort lands during an async schema validate', async () => {
    const controller = new AbortController();
    const handler = vi.fn();
    const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: async (value) => {
          // The interaction is cancelled while validation is still pending.
          controller.abort();
          return { value: value as { name: string } };
        },
      },
    };
    const adapter = mockAdapter({
      content: null,
      toolCalls: [{ id: 'c1', name: 'rename', arguments: { name: 'ada' } }],
    });

    const { response, messages } = await executeAgentLoop('rename it', {
      model: adapter,
      state: {},
      tools: [registerTool('rename', handler, { description: 'Rename', schema })],
      permissions: { canAccess: [], canExecute: ['rename'] },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(handler).not.toHaveBeenCalled();
    expect(response.error?.code).toBe('ABORTED');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].status).toBe('cancelled');

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content)).toEqual({
      status: 'cancelled',
      reason: 'Interaction aborted',
    });
  });

  it('carries the transformed value through toolCalls, onToolCall and tool_end, and the raw value through tool_start', async () => {
    const schema: StandardSchemaV1<{ name: string }, { name: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          const input = value as { name: string };
          return { value: { name: input.name.toUpperCase() } };
        },
      },
    };
    const handler = vi.fn((args: { name: string }) => ({ renamed: args.name }));
    const onToolCall = vi.fn();
    const events: AgentEvent[] = [];
    const adapter = mockAdapter(
      { content: null, toolCalls: [{ id: 'c1', name: 'rename', arguments: { name: 'ada' } }] },
      { content: 'Renamed.' },
    );

    const result = await runLoop('rename it', {
      model: adapter,
      state: {},
      tools: [registerTool('rename', handler, { description: 'Rename', schema })],
      permissions: { canAccess: [], canExecute: ['rename'] },
      options: { onToolCall, onEvent: (e) => events.push(e) },
      conversationHistory: [],
    });

    expect(result.toolCalls[0].args).toEqual({ name: 'ADA' });
    expect(onToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ args: { name: 'ADA' } }),
    );

    const toolStart = events.find((e) => e.type === 'tool_start');
    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolStart).toMatchObject({ args: { name: 'ada' } });
    expect(toolEnd).toMatchObject({ args: { name: 'ADA' } });
  });

  it('cancels when the handler rejects with an AbortError after the signal aborts', async () => {
    const controller = new AbortController();
    const handler = vi.fn(async () => {
      // The handler forwarded the signal and its own work rejected on cancel.
      controller.abort();
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      throw abortError;
    });
    const adapter = mockAdapter({
      content: null,
      toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
    });

    const { response, messages } = await executeAgentLoop('ping', {
      model: adapter,
      state: {},
      tools: [registerTool('ping', handler, { description: 'Ping' })],
      permissions: { canAccess: [], canExecute: ['ping'] },
      conversationHistory: [],
      signal: controller.signal,
    });

    expect(response.error?.code).toBe('ABORTED');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0].status).toBe('cancelled');
    expect(response.toolCalls[0].result).toBe(
      'Tool execution cancelled: interaction aborted',
    );

    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(JSON.parse(toolMessage!.content)).toEqual({
      status: 'cancelled',
      reason: 'Interaction aborted',
    });
    expect(toolMessage!.isError).toBeUndefined();
  });
});

describe('executeAgentLoop stop reasons', () => {
  it('reports TRUNCATED and keeps the partial answer', async () => {
    const adapter = mockAdapter({
      content: 'Here is the first half of the',
      stopReason: 'max_tokens',
    });

    const result = await runLoop('write me an essay', {
      model: adapter,
      state: {},
      tools: [],
      permissions: { canAccess: [], canExecute: [] },
      conversationHistory: [],
    });

    expect(result.message).toBe('Here is the first half of the');
    expect(result.error?.code).toBe('TRUNCATED');
    expect(result.error?.message).toContain('max tokens');
  });

  it('reports REFUSED', async () => {
    const adapter = mockAdapter({ content: '', stopReason: 'refusal' });

    const result = await runLoop('do something forbidden', {
      model: adapter,
      state: {},
      tools: [],
      permissions: { canAccess: [], canExecute: [] },
      conversationHistory: [],
    });

    expect(result.message).toBe('');
    expect(result.error?.code).toBe('REFUSED');
  });

  it('runs the tool calls of a truncated response as usual', async () => {
    const handler = vi.fn(() => ({ ok: true }));
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'ping', arguments: {} }],
        stopReason: 'max_tokens',
      },
      { content: 'done', stopReason: 'end' },
    );

    const result = await runLoop('ping', {
      model: adapter,
      state: {},
      tools: [registerTool('ping', handler, { description: 'Ping' })],
      permissions: { canAccess: [], canExecute: ['ping'] },
      conversationHistory: [],
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(result.error).toBeUndefined();
    expect(result.message).toBe('done');
  });
});

describe('executeAgentLoop transcript', () => {
  it('omits an empty final assistant message', async () => {
    const adapter = mockAdapter({ content: '' });

    const { messages } = await executeAgentLoop('hi', {
      model: adapter,
      state: {},
      tools: [],
      permissions: { canAccess: [], canExecute: [] },
      conversationHistory: [],
    });

    expect(messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('carries providerData onto the assistant messages it pushes', async () => {
    const toolTurnBlocks = [{ type: 'thinking', thinking: 'hmm', signature: 'sig-1' }];
    const finalBlocks = [{ type: 'text', text: 'Added.' }];
    const adapter = mockAdapter(
      {
        content: null,
        toolCalls: [{ id: 'c1', name: 'addToCart', arguments: { productId: 'a' } }],
        providerData: toolTurnBlocks,
      },
      { content: 'Added.', providerData: finalBlocks },
    );

    const { messages } = await executeAgentLoop('add it', {
      model: adapter,
      state: {},
      tools: defaultTools(),
      permissions: defaultPermissions,
      conversationHistory: [],
    });

    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0].providerData).toBe(toolTurnBlocks);
    expect(assistantMessages[1].providerData).toBe(finalBlocks);
  });
});
