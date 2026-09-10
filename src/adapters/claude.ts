import type {
  ClaudeAdapterConfig,
  ConversationMessage,
  LLMToolCall,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  StopReason,
  TokenUsage,
} from '../types';
import { AdapterError } from './AdapterError';
import { describeError } from '../utils/describeError';

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
  is_error?: boolean;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
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
  const cache = config.cache !== false;

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
        // Tools and the system prompt both render before the messages, so a
        // single breakpoint on the system block caches them together.
        body.system = cache
          ? ([
              {
                type: 'text',
                text: request.systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ] as SystemBlock[])
          : request.systemPrompt;
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
        throw new AdapterError(
          `Network error calling Anthropic API: ${describeError(error)}`,
          { cause: error },
        );
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AdapterError(
          `Anthropic API error (${res.status}): ${text || res.statusText}`,
          { status: res.status, body: text },
        );
      }

      let data: unknown;
      try {
        data = await res.json();
      } catch (error) {
        throw new AdapterError(
          'Failed to parse Anthropic API response as JSON',
          { cause: error },
        );
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
      const block: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? '',
        content: message.content,
      };
      if (message.isError) {
        block.is_error = true;
      }
      pendingToolResults.push(block);
      continue;
    }

    if (message.role === 'assistant') {
      const content = toAssistantContent(message);
      // Null means there is nothing the API would accept: dropping the message
      // is the only option, since an empty text block is rejected.
      if (content === null) continue;
      flushToolResults();
      result.push({ role: 'assistant', content });
      continue;
    }

    flushToolResults();
    result.push({ role: message.role, content: message.content });
  }

  flushToolResults();

  return result;
}

function toAssistantContent(
  message: ConversationMessage,
): string | ContentBlock[] | null {
  const replay = message.providerData;
  if (Array.isArray(replay) && replay.length > 0) {
    // Anthropic requires thinking blocks to come back with their signatures
    // untouched, so the raw blocks go out exactly as they arrived.
    return replay as ContentBlock[];
  }

  const toolCalls = message.toolCalls ?? [];
  if (toolCalls.length > 0) {
    const blocks: ContentBlock[] = [];
    if (message.content) {
      blocks.push({ type: 'text', text: message.content });
    }
    for (const call of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: isPlainObject(call.arguments) ? call.arguments : {},
      });
    }
    return blocks;
  }

  return message.content ? message.content : null;
}

function parseResponse(data: unknown): ModelResponse {
  const obj = data as Record<string, unknown>;
  const blocks = obj.content;

  if (!Array.isArray(blocks)) {
    throw new AdapterError(
      'Malformed Anthropic response: no content blocks returned',
    );
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

  const usage = obj.usage as AnthropicUsage | undefined;

  return {
    content: textParts.length > 0 ? textParts.join('') : null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: usage ? toTokenUsage(usage) : undefined,
    stopReason: toStopReason(obj.stop_reason),
    providerData: blocks,
  };
}

function toTokenUsage(usage: AnthropicUsage): TokenUsage {
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;

  const result: TokenUsage = {
    // Anthropic reports the cached tokens outside input_tokens, so the total
    // input for the call is the three fields added together.
    promptTokens: usage.input_tokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
    completionTokens: usage.output_tokens,
  };
  if (typeof cacheRead === 'number') {
    result.cacheReadTokens = cacheRead;
  }
  if (typeof cacheWrite === 'number') {
    result.cacheWriteTokens = cacheWrite;
  }
  return result;
}

function toStopReason(value: unknown): StopReason {
  switch (value) {
    case 'end_turn':
      return 'end';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      // stop_sequence, pause_turn and anything the API adds later.
      return 'other';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
