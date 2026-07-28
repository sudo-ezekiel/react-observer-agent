import type {
  AgentOptions,
  AgentResponse,
  AnyToolDefinition,
  ConversationMessage,
  JSONSchema,
  LLMToolDefinition,
  ModelAdapter,
  PermissionsConfig,
  StateSource,
  ToolCallResult,
} from '../types';
import { createStateSnapshot } from '../state/createStateSnapshot';
import { filterTools } from '../permissions/filterTools';
import { validateToolCall } from '../permissions/validateToolCall';
import { validateArgs } from '../tools/validateArgs';

const DEFAULT_MAX_TURNS = 5;
const READ_STATE_TOOL_NAME = '__readState';
const EMPTY_OBJECT_SCHEMA: JSONSchema = { type: 'object', properties: {} };

interface ExecutionContext {
  model: ModelAdapter;
  state: StateSource;
  tools: AnyToolDefinition[];
  permissions: PermissionsConfig;
  options?: AgentOptions;
  conversationHistory: ConversationMessage[];
  signal?: AbortSignal;
}

/**
 * The loop returns the LLM-facing message list alongside the response so the
 * provider can replay it verbatim on the next interaction. Structured tool
 * calls survive that way, which plain history text cannot express.
 */
export interface AgentLoopResult {
  response: AgentResponse;
  messages: ConversationMessage[];
}

/** Accumulates token usage across the turns of one interaction. */
class UsageTotal {
  private promptTokens = 0;
  private completionTokens = 0;
  private reported = false;

  add(usage?: { promptTokens: number; completionTokens: number }): void {
    if (!usage) return;
    this.reported = true;
    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
  }

  /** Undefined when no adapter response carried usage, rather than a false zero. */
  total(): { promptTokens: number; completionTokens: number } | undefined {
    if (!this.reported) return undefined;
    return {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function buildStateManifest(
  canAccess: string[],
  descriptions?: Record<string, string>,
): { key: string; description: string }[] {
  return canAccess.map((key) => ({
    key,
    description: descriptions?.[key] ?? key,
  }));
}

function buildStateManifestPrompt(manifest: { key: string; description: string }[]): string {
  if (manifest.length === 0) return '';
  const lines = manifest.map((m) => `- ${m.key}: ${m.description}`);
  return [
    'Available application state (use the __readState tool to access specific keys when needed):',
    ...lines,
    '',
    'Only request state keys relevant to the user\'s question. Do not read all keys at once unless necessary.',
  ].join('\n');
}

function buildReadStateToolDef(): LLMToolDefinition {
  return {
    name: READ_STATE_TOOL_NAME,
    description: 'Read specific keys from the application state. Only request keys you need.',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'State keys to read',
        },
      },
      required: ['keys'],
    },
  };
}

export async function executeAgentLoop(
  message: string,
  ctx: ExecutionContext,
): Promise<AgentLoopResult> {
  const { model, state, tools, permissions, options, signal } = ctx;
  const debug = options?.debug ?? false;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;

  // 1. Build state manifest (key names + descriptions, no values)
  const stateManifest = buildStateManifest(
    permissions.canAccess,
    permissions.stateDescriptions,
  );

  if (debug) {
    console.log('[react-observer-agent] State manifest:', stateManifest.map((m) => m.key));
  }

  // 2. Filter tools by canExecute
  const allowedTools = filterTools(tools, permissions.canExecute);
  const llmTools: LLMToolDefinition[] = [];

  for (const tool of allowedTools) {
    // A tool without a description gives the LLM nothing to decide on, so it
    // stays hidden. It remains executable if the model names it anyway.
    if (!tool.description) {
      if (debug) {
        console.warn(
          `[react-observer-agent] Tool "${tool.name}" has no description and is hidden from the LLM.`,
        );
      }
      continue;
    }

    llmTools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? EMPTY_OBJECT_SCHEMA,
    });
  }

  // Add internal readState tool if there are accessible state keys
  if (stateManifest.length > 0) {
    llmTools.push(buildReadStateToolDef());
  }

  if (debug) {
    console.log('[react-observer-agent] Available tools:', llmTools.map((t) => t.name));
  }

  // Build tool lookup
  const toolMap = new Map(allowedTools.map((t) => [t.name, t]));

  // 3. Build conversation messages
  const messages: ConversationMessage[] = [
    ...ctx.conversationHistory,
    { role: 'user', content: message },
  ];

  // Build system prompt with state manifest
  const manifestPrompt = buildStateManifestPrompt(stateManifest);
  const systemPrompt = [options?.systemPrompt, manifestPrompt]
    .filter(Boolean)
    .join('\n\n') || undefined;

  const allToolCalls: ToolCallResult[] = [];
  const usage = new UsageTotal();
  let turns = 0;
  let finalMessage = '';
  let completed = false;

  const abortedResult = (): AgentLoopResult => ({
    response: {
      message: '',
      toolCalls: allToolCalls,
      error: { message: 'Interaction aborted', code: 'ABORTED' },
      usage: usage.total(),
    },
    messages,
  });

  while (turns < maxTurns) {
    if (signal?.aborted) return abortedResult();

    turns++;

    if (debug) {
      console.log(`[react-observer-agent] Turn ${turns}/${maxTurns}`);
    }

    // 4. Send to LLM (state is empty — agent pulls via readState)
    const modelRequest = {
      // A snapshot, since the loop keeps appending to `messages` after this
      // call and an adapter that reads it asynchronously would see the churn.
      messages: [...messages],
      tools: llmTools,
      state: {} as Record<string, unknown>,
      systemPrompt,
      stateManifest,
      signal,
    };

    if (debug) {
      console.log('[react-observer-agent] LLM request:', {
        messageCount: modelRequest.messages.length,
        toolCount: modelRequest.tools.length,
        hasSystemPrompt: !!modelRequest.systemPrompt,
      });
    }

    let modelResponse;
    try {
      modelResponse = await model.sendMessage(modelRequest);
    } catch (error) {
      // An adapter that forwarded the signal rejects rather than resolving.
      if (isAbortError(error) || signal?.aborted) {
        return abortedResult();
      }
      throw error;
    }

    usage.add(modelResponse.usage);

    if (signal?.aborted) return abortedResult();

    if (debug) {
      console.log('[react-observer-agent] LLM response:', {
        content: modelResponse.content?.slice(0, 200),
        toolCalls: modelResponse.toolCalls?.map((tc) => tc.name),
      });
    }

    // 5a. Text-only response
    if (!modelResponse.toolCalls || modelResponse.toolCalls.length === 0) {
      finalMessage = modelResponse.content ?? '';
      completed = true;
      break;
    }

    // 5b. Has tool calls — process them
    messages.push({
      role: 'assistant',
      content: modelResponse.content ?? '',
      toolCalls: modelResponse.toolCalls,
    });

    for (const llmCall of modelResponse.toolCalls) {
      // Stop before starting any further side effects.
      if (signal?.aborted) return abortedResult();

      // Handle internal readState tool
      if (llmCall.name === READ_STATE_TOOL_NAME) {
        const args = llmCall.arguments as { keys?: string[] };
        const requestedKeys = args?.keys ?? [];

        // Filter to only keys in canAccess
        const allowedKeys = requestedKeys.filter((k) => permissions.canAccess.includes(k));
        const snapshot = createStateSnapshot(state, allowedKeys, debug);

        if (debug) {
          console.log('[react-observer-agent] readState requested:', requestedKeys);
          console.log('[react-observer-agent] readState allowed:', allowedKeys);
          console.log('[react-observer-agent] readState result:', snapshot);
        }

        messages.push({
          role: 'tool',
          content: JSON.stringify(snapshot),
          toolCallId: llmCall.id,
        });
        // readState is internal — NOT added to allToolCalls or onToolCall
        continue;
      }

      // i. Validate against canExecute (defense-in-depth)
      if (!validateToolCall(llmCall.name, permissions.canExecute)) {
        const deniedResult: ToolCallResult = {
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: `Tool "${llmCall.name}" is not permitted`,
          status: 'denied',
        };
        allToolCalls.push(deniedResult);
        options?.onToolCall?.({
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: deniedResult.result,
          status: 'denied',
        });

        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: deniedResult.result }),
          toolCallId: llmCall.id,
        });
        continue;
      }

      const toolDef = toolMap.get(llmCall.name);
      if (!toolDef) {
        const deniedResult: ToolCallResult = {
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: `Tool "${llmCall.name}" not found`,
          status: 'denied',
        };
        allToolCalls.push(deniedResult);
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: deniedResult.result }),
          toolCallId: llmCall.id,
        });
        continue;
      }

      // ii. Validate arguments before anything acts on them, so the user is
      // never asked to confirm a malformed call.
      if (toolDef.parameters) {
        const validation = validateArgs(llmCall.arguments, toolDef.parameters);
        if (!validation.valid) {
          const errorMessage = `Invalid arguments for tool "${llmCall.name}": ${validation.errors.join('; ')}`;

          if (debug) {
            console.warn(`[react-observer-agent] ${errorMessage}`);
          }

          const invalidResult: ToolCallResult = {
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: errorMessage,
            status: 'error',
          };
          allToolCalls.push(invalidResult);
          options?.onToolCall?.({
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: errorMessage,
            status: 'error',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errorMessage }),
            toolCallId: llmCall.id,
          });
          continue;
        }
      }

      // iii. Confirmation flow
      if (toolDef.confirm) {
        if (!options?.onConfirm) {
          if (debug) {
            console.warn(
              `[react-observer-agent] Tool "${llmCall.name}" requires confirmation but no onConfirm handler provided. Skipping.`,
            );
          }
          const cancelledResult: ToolCallResult = {
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: 'Tool execution cancelled: no confirmation handler provided',
            status: 'cancelled',
          };
          allToolCalls.push(cancelledResult);
          options?.onToolCall?.({
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: cancelledResult.result,
            status: 'cancelled',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({ status: 'cancelled', reason: 'No confirmation handler' }),
            toolCallId: llmCall.id,
          });
          continue;
        }

        const confirmed = await options.onConfirm({
          toolName: llmCall.name,
          args: llmCall.arguments,
          description: toolDef.description,
        });

        if (!confirmed) {
          const cancelledResult: ToolCallResult = {
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: 'Tool execution cancelled by user',
            status: 'cancelled',
          };
          allToolCalls.push(cancelledResult);
          options?.onToolCall?.({
            toolName: llmCall.name,
            args: llmCall.arguments,
            result: cancelledResult.result,
            status: 'cancelled',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({ status: 'cancelled', reason: 'User denied' }),
            toolCallId: llmCall.id,
          });
          continue;
        }
      }

      // iv. Execute tool
      try {
        const result = await toolDef.handler(llmCall.arguments);
        const status = toolDef.confirm ? 'confirmed' : 'success';

        if (debug) {
          console.log(`[react-observer-agent] Tool "${llmCall.name}" executed:`, { status, result });
        }

        const toolResult: ToolCallResult = {
          toolName: llmCall.name,
          args: llmCall.arguments,
          result,
          status,
        };
        allToolCalls.push(toolResult);
        options?.onToolCall?.({
          toolName: llmCall.name,
          args: llmCall.arguments,
          result,
          status,
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ result }),
          toolCallId: llmCall.id,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        const errorResult: ToolCallResult = {
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: errorMessage,
          status: 'error',
        };
        allToolCalls.push(errorResult);
        options?.onToolCall?.({
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: errorMessage,
          status: 'error',
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: errorMessage }),
          toolCallId: llmCall.id,
        });
      }
    }

    // Loop continues — send tool results back to LLM
  }

  // The model was still calling tools when the turn budget ran out, so it never
  // got to answer. Surface that as an error rather than an empty message.
  if (!completed) {
    if (debug) {
      console.warn(`[react-observer-agent] Max turns (${maxTurns}) reached`);
    }
    return {
      response: {
        message: '',
        toolCalls: allToolCalls,
        error: {
          message: `Agent did not produce a final response within ${maxTurns} turns`,
          code: 'MAX_TURNS',
        },
        usage: usage.total(),
      },
      messages,
    };
  }

  messages.push({ role: 'assistant', content: finalMessage });

  return {
    response: {
      message: finalMessage,
      toolCalls: allToolCalls,
      usage: usage.total(),
    },
    messages,
  };
}
