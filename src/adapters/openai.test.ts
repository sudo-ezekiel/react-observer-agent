import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openAIAdapter } from './openai';
import { AdapterError } from './AdapterError';
import type { ModelRequest } from '../types';

function createRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [{ role: 'user', content: 'Hello', toolCalls: [] }],
    tools: [],
    state: {},
    ...overrides,
  };
}

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const textResponse = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: 'Hello! How can I help?',
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function responseWithFinishReason(finishReason: string) {
  return {
    choices: [
      {
        message: { role: 'assistant', content: 'partial' },
        finish_reason: finishReason,
      },
    ],
  };
}

const toolCallResponse = {
  choices: [
    {
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'addToCart',
              arguments: '{"productId":"abc"}',
            },
          },
        ],
      },
    },
  ],
};

describe('openAIAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('initialization', () => {
    it('throws when neither apiKey nor baseURL is provided', () => {
      expect(() => openAIAdapter({})).toThrow(
        /requires either "apiKey" or "baseURL"/,
      );
    });

    it('creates adapter with apiKey only', () => {
      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      expect(adapter).toBeDefined();
      expect(typeof adapter.sendMessage).toBe('function');
    });

    it('creates adapter with baseURL only', () => {
      const adapter = openAIAdapter({ baseURL: '/api/agent' });
      expect(adapter).toBeDefined();
    });

    it('creates adapter with both apiKey and baseURL', () => {
      const adapter = openAIAdapter({
        apiKey: 'sk-test',
        baseURL: '/api/agent',
      });
      expect(adapter).toBeDefined();
    });
  });

  describe('request format', () => {
    it('sends correct request shape to OpenAI', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(createRequest());

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.openai.com/v1/chat/completions');
      expect(options.method).toBe('POST');

      const headers = options.headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer sk-test');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('gpt-4o');
      expect(body.temperature).toBe(0.2);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      expect(body.tools).toBeUndefined();
    });

    it('includes tools in OpenAI function format when provided', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          tools: [
            {
              name: 'addToCart',
              description: 'Add item to cart',
              parameters: {
                type: 'object',
                properties: { productId: { type: 'string' } },
              },
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'addToCart',
            description: 'Add item to cart',
            parameters: {
              type: 'object',
              properties: { productId: { type: 'string' } },
            },
          },
        },
      ]);
    });

    it('prepends system prompt as system message', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({ systemPrompt: 'You are a helpful assistant.' }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({
        role: 'system',
        content: 'You are a helpful assistant.',
      });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'Hello' });
    });

    it('uses custom baseURL', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ baseURL: '/api/agent' });
      await adapter.sendMessage(createRequest());

      expect(fetchMock.mock.calls[0][0]).toBe('/api/agent/chat/completions');
    });

    it('uses custom model and temperature', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({
        apiKey: 'sk-test',
        model: 'gpt-3.5-turbo',
        temperature: 0.8,
      });
      await adapter.sendMessage(createRequest());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('gpt-3.5-turbo');
      expect(body.temperature).toBe(0.8);
    });

    it('omits temperature entirely when configured as null', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test', temperature: null });
      await adapter.sendMessage(createRequest());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect('temperature' in body).toBe(false);
    });

    it('merges custom headers', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({
        baseURL: '/api/agent',
        headers: { 'X-Custom': 'test' },
      });
      await adapter.sendMessage(createRequest());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['X-Custom']).toBe('test');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('includes tool_call_id for tool messages', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          messages: [
            {
              role: 'tool',
              content: '{"result": true}',
              toolCallId: 'call_123',
              toolCalls: [],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].tool_call_id).toBe('call_123');
    });

    it('serializes assistant tool_calls followed by a matching tool result', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Add the sneakers', toolCalls: [] },
            {
              role: 'assistant',
              content: 'Adding it now.',
              toolCalls: [
                {
                  id: 'call_123',
                  name: 'addToCart',
                  arguments: { productId: 'abc' },
                },
              ],
            },
            {
              role: 'tool',
              content: '{"result":"added"}',
              toolCallId: 'call_123',
              toolCalls: [],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: 'Adding it now.',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: { name: 'addToCart', arguments: '{"productId":"abc"}' },
          },
        ],
      });
      expect(body.messages[2].tool_call_id).toBe('call_123');
    });

    it('sends null content for assistant messages that only carry tool calls', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'call_1',
                  name: '__readState',
                  arguments: { keys: ['cart'] },
                },
              ],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content).toBeNull();
      expect(body.messages[0].tool_calls[0].function.arguments).toBe(
        '{"keys":["cart"]}',
      );
    });

    it('omits tool_calls for messages without them', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Hello', toolCalls: [] },
            { role: 'assistant', content: 'Hi there', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0]).toEqual({ role: 'user', content: 'Hello' });
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: 'Hi there',
      });
    });

    it('skips assistant messages with empty content and no tool calls', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Hello', toolCalls: [] },
            { role: 'assistant', content: '', toolCalls: [] },
            { role: 'user', content: 'Still there?', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Still there?' },
      ]);
    });
  });

  describe('response parsing', () => {
    it('parses text-only response', async () => {
      globalThis.fetch = mockFetch(textResponse);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.content).toBe('Hello! How can I help?');
      expect(response.toolCalls).toBeUndefined();
      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });

    it('parses tool call response', async () => {
      globalThis.fetch = mockFetch(toolCallResponse);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.content).toBeNull();
      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toEqual({
        id: 'call_123',
        name: 'addToCart',
        arguments: { productId: 'abc' },
      });
    });

    it('handles response without usage data', async () => {
      globalThis.fetch = mockFetch({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
      });

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.usage).toBeUndefined();
    });

    it('maps cached prompt tokens to cacheReadTokens', async () => {
      globalThis.fetch = mockFetch({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      });

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.usage).toEqual({
        promptTokens: 100,
        completionTokens: 5,
        cacheReadTokens: 64,
      });
    });

    it('leaves cacheReadTokens off when the response reports no cached tokens', async () => {
      globalThis.fetch = mockFetch(textResponse);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });

    it('maps finish_reason "stop" to stopReason "end"', async () => {
      globalThis.fetch = mockFetch(responseWithFinishReason('stop'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('end');
    });

    it('maps finish_reason "tool_calls" to stopReason "tool_use"', async () => {
      globalThis.fetch = mockFetch(responseWithFinishReason('tool_calls'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('tool_use');
    });

    it('maps finish_reason "function_call" to stopReason "tool_use"', async () => {
      globalThis.fetch = mockFetch(responseWithFinishReason('function_call'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('tool_use');
    });

    it('maps finish_reason "length" to stopReason "max_tokens"', async () => {
      globalThis.fetch = mockFetch(responseWithFinishReason('length'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('max_tokens');
    });

    it('maps finish_reason "content_filter" to stopReason "refusal"', async () => {
      globalThis.fetch = mockFetch(responseWithFinishReason('content_filter'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('refusal');
    });

    it('maps an unknown or missing finish_reason to stopReason "other"', async () => {
      globalThis.fetch = mockFetch(textResponse);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.stopReason).toBe('other');
    });
  });

  describe('error handling', () => {
    it('throws on network error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /Network error.*Connection refused/,
      );
    });

    it('forwards the abort signal to fetch', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;
      const controller = new AbortController();

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await adapter.sendMessage(createRequest({ signal: controller.signal }));

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });

    it('rethrows an AbortError instead of rewrapping it as a network error', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('throws on non-OK status', async () => {
      globalThis.fetch = mockFetch(
        { error: { message: 'Rate limit exceeded' } },
        429,
      );

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /OpenAI API error \(429\)/,
      );
    });

    it('throws an AdapterError carrying the status and body on non-OK status', async () => {
      const errorBody = { error: { message: 'Invalid API key' } };
      globalThis.fetch = mockFetch(errorBody, 401);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const error = await adapter
        .sendMessage(createRequest())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).status).toBe(401);
      expect((error as AdapterError).body).toBe(JSON.stringify(errorBody));
    });

    it('throws an AdapterError without a status on network failure', async () => {
      const cause = new Error('Connection refused');
      globalThis.fetch = vi.fn().mockRejectedValue(cause);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const error = await adapter
        .sendMessage(createRequest())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).status).toBeUndefined();
      expect((error as AdapterError & { cause?: unknown }).cause).toBe(cause);
    });

    it('throws on malformed response (no choices)', async () => {
      globalThis.fetch = mockFetch({ choices: [] });

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /no choices returned/,
      );
    });

    it('throws on malformed response (no message)', async () => {
      globalThis.fetch = mockFetch({ choices: [{}] });

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /no message in first choice/,
      );
    });

    it('handles invalid JSON in tool call arguments gracefully', async () => {
      globalThis.fetch = mockFetch({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_456',
                  type: 'function',
                  function: { name: 'test', arguments: 'not-json' },
                },
              ],
            },
          },
        ],
      });

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      const response = await adapter.sendMessage(createRequest());

      expect(response.toolCalls![0].arguments).toBe('not-json');
    });
  });
});
