import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  OpenAIAdapterConfig,
} from '../types';

const DEFAULT_MODEL = 'gpt-4o';
const DEFAULT_TEMPERATURE = 0.2;
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

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
  const temperature = config.temperature ?? DEFAULT_TEMPERATURE;

  return {
    async sendMessage(request: ModelRequest): Promise<ModelResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...config.headers,
      };

      if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
      }

      const messages = request.systemPrompt
        ? [
            { role: 'system' as const, content: request.systemPrompt },
            ...request.messages.map(formatMessage),
          ]
        : request.messages.map(formatMessage);

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
        temperature,
      };

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
        });
      } catch (error) {
        throw new Error(
          `Network error calling OpenAI API: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `OpenAI API error (${res.status}): ${text || res.statusText}`,
        );
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new Error('Failed to parse OpenAI API response as JSON');
      }

      return parseResponse(data);
    },
  };
}

function formatMessage(msg: { role: string; content: string; toolCallId?: string }) {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.toolCallId) {
    formatted.tool_call_id = msg.toolCallId;
  }
  return formatted;
}

function parseResponse(data: unknown): ModelResponse {
  const obj = data as Record<string, unknown>;
  const choices = obj.choices as Array<Record<string, unknown>> | undefined;

  if (!choices || choices.length === 0) {
    throw new Error('Malformed OpenAI response: no choices returned');
  }

  const message = choices[0].message as Record<string, unknown> | undefined;
  if (!message) {
    throw new Error('Malformed OpenAI response: no message in first choice');
  }

  const content = (message.content as string) ?? null;
  const toolCalls = message.tool_calls as
    | Array<{
        id: string;
        function: { name: string; arguments: string };
      }>
    | undefined;

  const usage = obj.usage as
    | { prompt_tokens: number; completion_tokens: number }
    | undefined;

  return {
    content,
    toolCalls: toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJSON(tc.function.arguments),
    })),
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
        }
      : undefined,
  };
}

function safeParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
