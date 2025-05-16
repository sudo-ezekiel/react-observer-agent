import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { openAIAdapter } from './openai';
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
      const adapter = openAIAdapter({ apiKey: 'sk-test', baseURL: '/api/agent' });
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
              parameters: { type: 'object', properties: { productId: { type: 'string' } } },
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
            parameters: { type: 'object', properties: { productId: { type: 'string' } } },
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
      expect(body.messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
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
            { role: 'tool', content: '{"result": true}', toolCallId: 'call_123', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].tool_call_id).toBe('call_123');
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
  });

  describe('error handling', () => {
    it('throws on network error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /Network error.*Connection refused/,
      );
    });

    it('throws on non-OK status', async () => {
      globalThis.fetch = mockFetch({ error: { message: 'Rate limit exceeded' } }, 429);

      const adapter = openAIAdapter({ apiKey: 'sk-test' });
      await expect(adapter.sendMessage(createRequest())).rejects.toThrow(
        /OpenAI API error \(429\)/,
      );
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
