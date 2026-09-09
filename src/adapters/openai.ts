import type {
  ConversationMessage,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  OpenAIAdapterConfig,
  StopReason,
  TokenUsage,
} from '../types';
import { AdapterError } from './AdapterError';
import { describeError } from '../utils/describeError';

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_TEMPERATURE = 0.2;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export function openAIAdapter(config: OpenAIAdapterConfig): ModelAdapter {
  if (!config.apiKey && !config.baseURL) {
    throw new Error(
      'openAIAdapter requires either "apiKey" or "baseURL". ' +
        'Provide an API key for direct access, or a baseURL to route through your backend proxy.',
    );
  }

  const baseURL = config.baseURL
    ? config.baseURL.replace(/\/+$/, '')
    : OPENAI_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  // Null means "leave the field out": reasoning models reject any temperature
  // other than their own default. Undefined keeps the 0.2 default.
  const temperature =
    config.temperature === null
      ? undefined
      : (config.temperature ?? DEFAULT_TEMPERATURE);

  return {
    async sendMessage(request: ModelRequest): Promise<ModelResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.headers,
      };

      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const conversation = request.messages
        .filter(isSendable)
        .map(formatMessage);

      const messages = request.systemPrompt
        ? [
            { role: 'system' as const, content: request.systemPrompt },
            ...conversation,
          ]
        : conversation;

      const tools =
        request.tools.length > 0
          ? request.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            }))
          : undefined;

      const body: Record<string, unknown> = {
        model,
        messages,
      };

      if (temperature !== undefined) {
        body.temperature = temperature;
      }

      if (tools) {
        body.tools = tools;
      }

      const url = baseURL.includes('/chat/completions')
        ? baseURL
        : `${baseURL}/chat/completions`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        // An abort is a caller decision, not a transport failure. Rewrapping it
        // would hide the AbortError name the agent loop checks for.
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new AdapterError(
          `Network error calling OpenAI API: ${describeError(error)}`,
          { cause: error },
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AdapterError(
          `OpenAI API error (${res.status}): ${text || res.statusText}`,
          { status: res.status, body: text },
        );
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch (error) {
        throw new AdapterError('Failed to parse OpenAI API response as JSON', {
          cause: error,
        });
      }

      return parseResponse(data);
    },
  };
}

/**
 * The API rejects an assistant message carrying neither content nor tool calls,
 * and the loop can produce one when a turn ends on an empty completion.
 */
function isSendable(msg: ConversationMessage): boolean {
  if (msg.role !== 'assistant') return true;
  return msg.content !== '' || (msg.toolCalls?.length ?? 0) > 0;
}

function formatMessage(msg: ConversationMessage) {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.toolCallId) {
    formatted.tool_call_id = msg.toolCallId;
  }

  // OpenAI rejects tool messages that do not follow an assistant message
  // carrying the matching tool_calls entry.
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    formatted.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments:
          typeof tc.arguments === 'string'
            ? tc.arguments
            : JSON.stringify(tc.arguments ?? {}),
      },
    }));
    if (msg.content === '') {
      formatted.content = null;
    }
  }

  return formatted;
}

function parseResponse(data: unknown): ModelResponse {
  const obj = data as Record<string, unknown>;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;

  if (!choices || choices.length === 0) {
    throw new AdapterError('Malformed OpenAI response: no choices returned');
  }

  const message = choices[0].message as Record<string, unknown> | undefined;
  if (!message) {
    throw new AdapterError(
      'Malformed OpenAI response: no message in first choice',
    );
  }

  const content = (message.content as string) ?? null;
  const toolCalls = message.tool_calls as
    | Array<{
        id: string;
        function: { name: string; arguments: string };
      }>
    | undefined;

  const usage = obj.usage as OpenAIUsage | undefined;

  return {
    content,
    toolCalls: toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJSON(tc.function.arguments),
    })),
    usage: usage ? mapUsage(usage) : undefined,
    stopReason: mapStopReason(choices[0].finish_reason),
  };
}

function mapUsage(usage: OpenAIUsage): TokenUsage {
  const cached = usage.prompt_tokens_details?.cached_tokens;

  const mapped: TokenUsage = {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
  };

  if (typeof cached === 'number') {
    mapped.cacheReadTokens = cached;
  }

  return mapped;
}

function mapStopReason(finishReason: unknown): StopReason {
  switch (finishReason) {
    case 'stop':
      return 'end';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function safeParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
