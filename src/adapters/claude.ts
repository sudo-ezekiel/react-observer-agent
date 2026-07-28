import type {
  ClaudeAdapterConfig,
  ConversationMessage,
  LLMToolCall,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from '../types';

const DEFAULT_MODEL = 'claude-opus-5';
const DEFAULT_MAX_TOKENS = 16000;
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

interface TextBlock {
  type: 'text';
  text: string;
}

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export function claudeAdapter(config: ClaudeAdapterConfig): ModelAdapter {
  if (!config.apiKey && !config.baseURL) {
    throw new Error(
      'claudeAdapter requires either "apiKey" or "baseURL". ' +
        'Provide an API key for direct access, or a baseURL to route through your backend proxy.',
    );
  }

  const baseURL = config.baseURL
    ? config.baseURL.replace(/\/+$/, '')
    : ANTHROPIC_BASE_URL;
  const model = config.model ?? DEFAULT_MODEL;
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

  return {
    async sendMessage(request: ModelRequest): Promise<ModelResponse> {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      };

      if (config.apiKey) {
        headers['x-api-key'] = config.apiKey;
      }

      // Spread last so consumers can override anything above, including adding
      // the CORS opt-in header needed for direct browser access.
      Object.assign(headers, config.headers);

      const body: Record<string, unknown> = {
        model,
        max_tokens: maxTokens,
        messages: toAnthropicMessages(request.messages),
      };

      if (request.systemPrompt) {
        body.system = request.systemPrompt;
      }

      if (request.tools.length > 0) {
        body.tools = request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        }));
      }

      const url = baseURL.includes('/v1/messages')
        ? baseURL
        : `${baseURL}/v1/messages`;

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw new Error(
          `Network error calling Anthropic API: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
          `Anthropic API error (${res.status}): ${text || res.statusText}`,
        );
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new Error('Failed to parse Anthropic API response as JSON');
      }

      return parseResponse(data);
    },
  };
}

/**
 * Anthropic expects tool calls as `tool_use` blocks on an assistant message and
 * their results as `tool_result` blocks on a following user message, so a run of
 * internal tool messages collapses into one user message.
 */
function toAnthropicMessages(
  messages: ConversationMessage[],
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let pendingToolResults: ToolResultBlock[] = [];

  const flushToolResults = () => {
    if (pendingToolResults.length > 0) {
      result.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      });
      continue;
    }

    flushToolResults();

    if (
      message.role === 'assistant' &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      const blocks: ContentBlock[] = [];
      if (message.content) {
        blocks.push({ type: 'text', text: message.content });
      }
      for (const call of message.toolCalls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: isPlainObject(call.arguments) ? call.arguments : {},
        });
      }
      result.push({ role: 'assistant', content: blocks });
      continue;
    }

    result.push({ role: message.role, content: message.content });
  }

  flushToolResults();

  return result;
}

function parseResponse(data: unknown): ModelResponse {
  const obj = data as Record<string, unknown>;
  const blocks = obj.content;

  if (!Array.isArray(blocks)) {
    throw new Error('Malformed Anthropic response: no content blocks returned');
  }

  const textParts: string[] = [];
  const toolCalls: LLMToolCall[] = [];

  for (const block of blocks as ContentBlock[]) {
    if (block?.type === 'text') {
      textParts.push(block.text);
    } else if (block?.type === 'tool_use') {
      // Already parsed by the API, unlike OpenAI's JSON-string arguments.
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
    // Other block types (thinking, for example) carry nothing this loop needs.
  }

  const usage = obj.usage as
    | { input_tokens: number; output_tokens: number }
    | undefined;

  return {
    content: textParts.length > 0 ? textParts.join('') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage
      ? {
          promptTokens: usage.input_tokens,
          completionTokens: usage.output_tokens,
        }
      : undefined,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
