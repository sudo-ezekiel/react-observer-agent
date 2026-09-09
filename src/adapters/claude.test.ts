import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { claudeAdapter } from './claude';
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
  content: [{ type: 'text', text: 'Hello! How can I help?' }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

const toolUseResponse = {
  content: [
    {
      type: 'tool_use',
      id: 'toolu_123',
      name: 'addToCart',
      input: { productId: 'abc' },
    },
  ],
};

describe('claudeAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('initialization', () => {
    it('throws when neither apiKey nor baseURL is provided', () => {
      expect(() => claudeAdapter({})).toThrow(
        /requires either "apiKey" or "baseURL"/,
      );
    });

    it('creates adapter with apiKey only', () => {
      expect(typeof claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage).toBe(
        'function',
      );
    });

    it('creates adapter with baseURL only', () => {
      expect(claudeAdapter({ baseURL: '/api/agent' })).toBeDefined();
    });
  });

  describe('request format', () => {
    it('sends the documented endpoint, headers and body', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest(),
      );

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(options.method).toBe('POST');
      expect(options.headers['x-api-key']).toBe('sk-ant-test');
      expect(options.headers['anthropic-version']).toBe('2023-06-01');
      expect(options.headers['Content-Type']).toBe('application/json');

      const body = JSON.parse(options.body);
      expect(body.model).toBe('claude-opus-5');
      expect(body.max_tokens).toBe(16000);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
      // Sampling parameters are rejected by current Claude models.
      expect(body.temperature).toBeUndefined();
      expect(body.tools).toBeUndefined();
    });

    it('omits the api key header when routing through a proxy', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ baseURL: '/api/agent' }).sendMessage(
        createRequest(),
      );

      expect(fetchMock.mock.calls[0][0]).toBe('/api/agent/v1/messages');
      expect(fetchMock.mock.calls[0][1].headers['x-api-key']).toBeUndefined();
    });

    it('lets custom headers override the defaults', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({
        baseURL: '/api/agent',
        headers: {
          Authorization: 'Bearer session',
          'anthropic-version': '2024-01-01',
        },
      }).sendMessage(createRequest());

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['Authorization']).toBe('Bearer session');
      expect(headers['anthropic-version']).toBe('2024-01-01');
    });

    it('uses a custom model and maxTokens', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-5',
        maxTokens: 2048,
      }).sendMessage(createRequest());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.model).toBe('claude-sonnet-5');
      expect(body.max_tokens).toBe(2048);
    });

    it('sends the system prompt as a cached text block by default', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({ systemPrompt: 'You are helpful.' }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system).toEqual([
        {
          type: 'text',
          text: 'You are helpful.',
          cache_control: { type: 'ephemeral' },
        },
      ]);
      expect(body.messages[0].role).toBe('user');
    });

    it('sends the system prompt as a plain string when cache is false', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test', cache: false }).sendMessage(
        createRequest({ systemPrompt: 'You are helpful.' }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.system).toBe('You are helpful.');
    });

    it('omits the system field when there is no system prompt', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest(),
      );

      expect(JSON.parse(fetchMock.mock.calls[0][1].body).system).toBeUndefined();
    });

    it('maps tools to input_schema', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
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
          name: 'addToCart',
          description: 'Add item to cart',
          input_schema: {
            type: 'object',
            properties: { productId: { type: 'string' } },
          },
        },
      ]);
    });

    it('forwards the abort signal to fetch', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;
      const controller = new AbortController();

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({ signal: controller.signal }),
      );

      expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
    });
  });

  describe('message conversion', () => {
    it('turns an assistant tool call into text and tool_use blocks', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Add it', toolCalls: [] },
            {
              role: 'assistant',
              content: 'Adding it now.',
              toolCalls: [
                {
                  id: 'toolu_1',
                  name: 'addToCart',
                  arguments: { productId: 'abc' },
                },
              ],
            },
            {
              role: 'tool',
              content: '{"ok":true}',
              toolCallId: 'toolu_1',
              toolCalls: [],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'text', text: 'Adding it now.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'addToCart',
            input: { productId: 'abc' },
          },
        ],
      });
      expect(body.messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"ok":true}',
          },
        ],
      });
    });

    it('omits the text block when an assistant message is only tool calls', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                {
                  id: 'toolu_1',
                  name: '__readState',
                  arguments: { keys: ['cart'] },
                },
              ],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content).toEqual([
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: '__readState',
          input: { keys: ['cart'] },
        },
      ]);
    });

    it('merges consecutive tool results into a single user message', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 't1', name: 'a', arguments: {} },
                { id: 't2', name: 'b', arguments: {} },
              ],
            },
            { role: 'tool', content: 'one', toolCallId: 't1', toolCalls: [] },
            { role: 'tool', content: 'two', toolCallId: 't2', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[1]).toEqual({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'one' },
          { type: 'tool_result', tool_use_id: 't2', content: 'two' },
        ],
      });
    });

    it('substitutes an empty object for non-object tool arguments', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 't1', name: 'a', arguments: 'not-json' }],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content[0].input).toEqual({});
    });

    it('replays providerData blocks verbatim, signatures included', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;
      const rawBlocks = [
        { type: 'thinking', thinking: 'Checking the cart.', signature: 'sig-1' },
        { type: 'text', text: 'Adding it now.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'addToCart',
          input: { productId: 'abc' },
        },
      ];

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Add it', toolCalls: [] },
            {
              role: 'assistant',
              content: 'Adding it now.',
              toolCalls: [
                {
                  id: 'toolu_1',
                  name: 'addToCart',
                  arguments: { productId: 'abc' },
                },
              ],
              providerData: rawBlocks,
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[1]).toEqual({
        role: 'assistant',
        content: rawBlocks,
      });
    });

    it('rebuilds blocks when providerData is not a non-empty array', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: 'Working on it.',
              toolCalls: [{ id: 't1', name: 'a', arguments: {} }],
              providerData: [],
            },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content).toEqual([
        { type: 'text', text: 'Working on it.' },
        { type: 'tool_use', id: 't1', name: 'a', input: {} },
      ]);
    });

    it('skips an empty assistant message that carries no tool calls', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            { role: 'user', content: 'Hello', toolCalls: [] },
            { role: 'assistant', content: '', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('marks a failed tool message with is_error', async () => {
      const fetchMock = mockFetch(textResponse);
      globalThis.fetch = fetchMock;

      await claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(
        createRequest({
          messages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [
                { id: 't1', name: 'a', arguments: {} },
                { id: 't2', name: 'b', arguments: {} },
              ],
            },
            {
              role: 'tool',
              content: '{"error":"denied"}',
              toolCallId: 't1',
              toolCalls: [],
              isError: true,
            },
            { role: 'tool', content: 'ok', toolCallId: 't2', toolCalls: [] },
          ],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[1].content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: '{"error":"denied"}',
          is_error: true,
        },
        { type: 'tool_result', tool_use_id: 't2', content: 'ok' },
      ]);
    });
  });

  describe('response parsing', () => {
    it('parses a text response and usage', async () => {
      globalThis.fetch = mockFetch(textResponse);

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.content).toBe('Hello! How can I help?');
      expect(response.toolCalls).toBeUndefined();
      expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    });

    it('parses a tool_use response with already-parsed arguments', async () => {
      globalThis.fetch = mockFetch(toolUseResponse);

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.content).toBeNull();
      expect(response.toolCalls).toEqual([
        { id: 'toolu_123', name: 'addToCart', arguments: { productId: 'abc' } },
      ]);
    });

    it('joins multiple text blocks and ignores unknown block types', async () => {
      globalThis.fetch = mockFetch({
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Part one. ' },
          { type: 'text', text: 'Part two.' },
        ],
      });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.content).toBe('Part one. Part two.');
    });

    it('returns text and tool calls together when both are present', async () => {
      globalThis.fetch = mockFetch({
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: {} },
        ],
      });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.content).toBe('Let me check.');
      expect(response.toolCalls).toHaveLength(1);
    });

    it('handles a response without usage', async () => {
      globalThis.fetch = mockFetch({ content: [{ type: 'text', text: 'hi' }] });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.usage).toBeUndefined();
    });

    it('maps the cache token counts when the API reports them', async () => {
      globalThis.fetch = mockFetch({
        content: [{ type: 'text', text: 'hi' }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 120,
        },
      });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.usage).toEqual({
        promptTokens: 10,
        completionTokens: 5,
        cacheReadTokens: 900,
        cacheWriteTokens: 120,
      });
    });

    it.each([
      ['end_turn', 'end'],
      ['tool_use', 'tool_use'],
      ['max_tokens', 'max_tokens'],
      ['refusal', 'refusal'],
      ['pause_turn', 'other'],
      [undefined, 'other'],
    ])('maps stop_reason %s to %s', async (stopReason, expected) => {
      globalThis.fetch = mockFetch({
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: stopReason,
      });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.stopReason).toBe(expected);
    });

    it('returns the raw content blocks as providerData', async () => {
      const blocks = [
        { type: 'thinking', thinking: 'Hmm.', signature: 'sig-1' },
        { type: 'text', text: 'Done.' },
      ];
      globalThis.fetch = mockFetch({ content: blocks });

      const response = await claudeAdapter({
        apiKey: 'sk-ant-test',
      }).sendMessage(createRequest());

      expect(response.providerData).toEqual(blocks);
    });
  });

  describe('error handling', () => {
    it('throws on network error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      await expect(
        claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(createRequest()),
      ).rejects.toThrow(/Network error.*Connection refused/);
    });

    it('rethrows an AbortError untouched', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(
        claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(createRequest()),
      ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('throws on non-OK status', async () => {
      globalThis.fetch = mockFetch({ error: { message: 'overloaded' } }, 529);

      await expect(
        claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(createRequest()),
      ).rejects.toThrow(/Anthropic API error \(529\)/);
    });

    it('carries the status and body on the AdapterError', async () => {
      const payload = { error: { message: 'invalid api key' } };
      globalThis.fetch = mockFetch(payload, 401);

      const error = await claudeAdapter({ apiKey: 'sk-ant-test' })
        .sendMessage(createRequest())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdapterError);
      expect(error).toMatchObject({
        name: 'AdapterError',
        status: 401,
        body: JSON.stringify(payload),
      });
    });

    it('throws an AdapterError without a status on network failure', async () => {
      const cause = new Error('Connection refused');
      globalThis.fetch = vi.fn().mockRejectedValue(cause);

      const error = await claudeAdapter({ apiKey: 'sk-ant-test' })
        .sendMessage(createRequest())
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AdapterError);
      expect(error).toMatchObject({ status: undefined, cause });
    });

    it('throws on a malformed response', async () => {
      globalThis.fetch = mockFetch({ id: 'msg_1' });

      await expect(
        claudeAdapter({ apiKey: 'sk-ant-test' }).sendMessage(createRequest()),
      ).rejects.toThrow(/no content blocks returned/);
    });
  });
});
