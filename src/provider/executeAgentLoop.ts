import type {
  AgentError,
  AgentEvent,
  AgentOptions,
  AgentResponse,
  AnyToolDefinition,
  ConversationMessage,
  JSONSchema,
  LLMToolDefinition,
  ModelAdapter,
  PermissionsConfig,
  StateSource,
  TokenUsage,
  ToolCallResult,
} from '../types';
import { createStateSnapshot } from '../state/createStateSnapshot';
import { filterTools } from '../permissions/filterTools';
import { validateToolCall } from '../permissions/validateToolCall';
import { validateArgs } from '../tools/validateArgs';
import { validateToolArgs } from '../tools/validateToolArgs';
import { abortRace } from '../utils/abortRace';
import { describeError } from '../utils/describeError';

const DEFAULT_MAX_TURNS = 5;
const ABORTED_TOOL_RESULT = 'Tool execution cancelled: interaction aborted';
const READ_STATE_TOOL_NAME = '__readState';
const EMPTY_OBJECT_SCHEMA: JSONSchema = { type: 'object', properties: {} };
const READ_STATE_SCHEMA: JSONSchema = {
  type: 'object',
  properties: {
    keys: {
      type: 'array',
      items: { type: 'string' },
      description: 'State keys to read',
    },
  },
  required: ['keys'],
};

/** What a handler invocation produced, reported once after the try/catch. */
type ToolCallOutcome =
  | { kind: 'success'; result: unknown; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' };

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
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private reported = false;

  add(usage?: TokenUsage): void {
    if (!usage) return;
    this.reported = true;
    this.promptTokens += usage.promptTokens ?? 0;
    this.completionTokens += usage.completionTokens ?? 0;
    this.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
  }

  /** Undefined when no adapter response carried usage, rather than a false zero. */
  total(): TokenUsage | undefined {
    if (!this.reported) return undefined;
    const total: TokenUsage = {
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
    };
    // Only providers with a cache report these, so a zero would be a claim.
    if (this.cacheReadTokens > 0) total.cacheReadTokens = this.cacheReadTokens;
    if (this.cacheWriteTokens > 0)
      total.cacheWriteTokens = this.cacheWriteTokens;
    return total;
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

function buildStateManifestPrompt(
  manifest: { key: string; description: string }[],
): string {
  if (manifest.length === 0) return '';
  const lines = manifest.map((m) => `- ${m.key}: ${m.description}`);
  return [
    'Available application state (use the __readState tool to access specific keys when needed):',
    ...lines,
    '',
    "Only request state keys relevant to the user's question. Do not read all keys at once unless necessary.",
  ].join('\n');
}

function buildReadStateToolDef(): LLMToolDefinition {
  return {
    name: READ_STATE_TOOL_NAME,
    description:
      'Read specific keys from the application state. Only request keys you need.',
    parameters: READ_STATE_SCHEMA,
  };
}

export async function executeAgentLoop(
  message: string,
  ctx: ExecutionContext,
): Promise<AgentLoopResult> {
  const { model, state, tools, permissions, options, signal } = ctx;
  const debug = options?.debug ?? false;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;

  // Key names and descriptions only. Values stay behind __readState.
  const stateManifest = buildStateManifest(
    permissions.canAccess,
    permissions.stateDescriptions,
  );

  if (debug) {
    console.log(
      '[react-observer-agent] State manifest:',
      stateManifest.map((m) => m.key),
    );
  }

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

  if (stateManifest.length > 0) {
    llmTools.push(buildReadStateToolDef());
  }

  if (debug) {
    console.log(
      '[react-observer-agent] Available tools:',
      llmTools.map((t) => t.name),
    );
  }

  const toolMap = new Map(allowedTools.map((t) => [t.name, t]));

  const messages: ConversationMessage[] = [
    ...ctx.conversationHistory,
    { role: 'user', content: message },
  ];

  const manifestPrompt = buildStateManifestPrompt(stateManifest);
  const systemPrompt =
    [options?.systemPrompt, manifestPrompt].filter(Boolean).join('\n\n') ||
    undefined;

  const allToolCalls: ToolCallResult[] = [];
  const usage = new UsageTotal();
  let turns = 0;
  let finalMessage = '';
  let finalProviderData: unknown;
  let stopError: AgentError | undefined;
  let completed = false;

  const emit = (event: AgentEvent): void => {
    options?.onEvent?.(event);
  };

  /**
   * The single place a user tool call is reported, so every call produces
   * exactly one entry, one callback, and one tool_end.
   */
  const record = (result: ToolCallResult): void => {
    allToolCalls.push(result);
    options?.onToolCall?.({
      toolName: result.toolName,
      args: result.args,
      result: result.result,
      status: result.status,
    });
    emit({
      type: 'tool_end',
      toolName: result.toolName,
      args: result.args,
      result: result.result,
      status: result.status,
    });
  };

  const abortedResult = (): AgentLoopResult => ({
    response: {
      message: '',
      toolCalls: allToolCalls,
      error: { message: 'Interaction aborted', code: 'ABORTED' },
      usage: usage.total(),
    },
    messages,
  });

  /**
   * Cancels the call in flight and ends the interaction, so an abort that lands
   * mid-call still leaves exactly one report per tool_start.
   */
  const cancelForAbort = (
    toolName: string,
    args: unknown,
    toolCallId: string,
  ): AgentLoopResult => {
    record({
      toolName,
      args,
      result: ABORTED_TOOL_RESULT,
      status: 'cancelled',
    });
    messages.push({
      role: 'tool',
      content: JSON.stringify({
        status: 'cancelled',
        reason: 'Interaction aborted',
      }),
      toolCallId,
    });
    return abortedResult();
  };

  while (turns < maxTurns) {
    if (signal?.aborted) return abortedResult();

    turns++;

    if (debug) {
      console.log(`[react-observer-agent] Turn ${turns}/${maxTurns}`);
    }

    // `state` stays empty: the model pulls what it needs through __readState.
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

    emit({ type: 'turn_start', turn: turns, maxTurns });

    let modelResponse;
    const modelAbort = abortRace(signal);
    try {
      // Raced rather than awaited bare: a custom adapter that ignores the
      // signal would otherwise hold the interaction open past a cancel.
      modelResponse = await Promise.race([
        model.sendMessage(modelRequest),
        modelAbort.promise,
      ]);
    } catch (error) {
      // An adapter that forwarded the signal rejects rather than resolving.
      if (isAbortError(error) || signal?.aborted) {
        return abortedResult();
      }
      throw error;
    } finally {
      modelAbort.release();
    }

    usage.add(modelResponse.usage);

    if (signal?.aborted) return abortedResult();

    if (debug) {
      console.log('[react-observer-agent] LLM response:', {
        content: modelResponse.content?.slice(0, 200),
        toolCalls: modelResponse.toolCalls?.map((tc) => tc.name),
      });
    }

    // Nothing left to run, so this is the answer.
    if (!modelResponse.toolCalls || modelResponse.toolCalls.length === 0) {
      finalMessage = modelResponse.content ?? '';
      finalProviderData = modelResponse.providerData;

      // A cut-off or refused answer is still the answer, but the caller has to
      // be able to tell it apart from a complete one.
      if (modelResponse.stopReason === 'max_tokens') {
        stopError = {
          message: 'Model output was cut off by the max tokens limit',
          code: 'TRUNCATED',
        };
      } else if (modelResponse.stopReason === 'refusal') {
        stopError = {
          message: 'Model declined to answer',
          code: 'REFUSED',
        };
      }

      completed = true;
      break;
    }

    messages.push({
      role: 'assistant',
      content: modelResponse.content ?? '',
      toolCalls: modelResponse.toolCalls,
      providerData: modelResponse.providerData,
    });

    for (const llmCall of modelResponse.toolCalls) {
      // Stop before starting any further side effects.
      if (signal?.aborted) return abortedResult();

      if (llmCall.name === READ_STATE_TOOL_NAME) {
        // Validated against the schema the tool advertises, since a model that
        // sends `keys` as a string would otherwise crash the loop.
        const readValidation = validateArgs(
          llmCall.arguments,
          READ_STATE_SCHEMA,
        );
        if (!readValidation.valid) {
          const errorMessage = `Invalid arguments for ${READ_STATE_TOOL_NAME}: ${readValidation.errors.join('; ')}`;

          if (debug) {
            console.warn(`[react-observer-agent] ${errorMessage}`);
          }

          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errorMessage }),
            toolCallId: llmCall.id,
            isError: true,
          });
          continue;
        }

        const args = llmCall.arguments as { keys?: unknown[] };
        const requestedKeys = (args?.keys ?? []).filter(
          (k): k is string => typeof k === 'string',
        );

        const allowedKeys = requestedKeys.filter((k) =>
          permissions.canAccess.includes(k),
        );
        const snapshot = createStateSnapshot(
          state,
          allowedKeys,
          debug,
          options?.maxStateBytes,
        );

        if (debug) {
          console.log(
            '[react-observer-agent] readState requested:',
            requestedKeys,
          );
          console.log('[react-observer-agent] readState allowed:', allowedKeys);
          console.log('[react-observer-agent] readState result:', snapshot);
        }

        emit({
          type: 'state_read',
          requested: requestedKeys,
          keys: allowedKeys,
        });

        messages.push({
          role: 'tool',
          content: JSON.stringify(snapshot),
          toolCallId: llmCall.id,
        });
        // Internal, so it never reaches allToolCalls or onToolCall.
        continue;
      }

      // Fired before the permission check so that a denied call is as visible
      // as an executed one, and every start has a matching end.
      emit({
        type: 'tool_start',
        toolName: llmCall.name,
        args: llmCall.arguments,
      });

      // Re-checked after the model answered, so a hallucinated or injected
      // name is rejected even though it was never advertised.
      if (!validateToolCall(llmCall.name, permissions.canExecute)) {
        const deniedResult: ToolCallResult = {
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: `Tool "${llmCall.name}" is not permitted`,
          status: 'denied',
        };
        record(deniedResult);

        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: deniedResult.result }),
          toolCallId: llmCall.id,
          isError: true,
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
        record(deniedResult);
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: deniedResult.result }),
          toolCallId: llmCall.id,
          isError: true,
        });
        continue;
      }

      // Validated before anything acts on the arguments, so the user is never
      // asked to confirm a malformed call.
      const validation = await validateToolArgs(toolDef, llmCall.arguments);
      if (!validation.valid) {
        const errorMessage = `Invalid arguments for tool "${llmCall.name}": ${validation.errors.join('; ')}`;

        if (debug) {
          console.warn(`[react-observer-agent] ${errorMessage}`);
        }

        record({
          toolName: llmCall.name,
          args: llmCall.arguments,
          result: errorMessage,
          status: 'error',
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: errorMessage }),
          toolCallId: llmCall.id,
          isError: true,
        });
        continue;
      }

      // A schema may apply defaults or transforms, so this is what the user
      // confirms, what the handler runs on, and what every later report shows.
      const value = validation.value;

      // Validation can await a schema, so the interaction may have been
      // cancelled while it ran.
      if (signal?.aborted) {
        return cancelForAbort(llmCall.name, value, llmCall.id);
      }

      if (toolDef.confirm) {
        if (!options?.onConfirm) {
          if (debug) {
            console.warn(
              `[react-observer-agent] Tool "${llmCall.name}" requires confirmation but no onConfirm handler provided. Skipping.`,
            );
          }
          record({
            toolName: llmCall.name,
            args: value,
            result:
              'Tool execution cancelled: no confirmation handler provided',
            status: 'cancelled',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              status: 'cancelled',
              reason: 'No confirmation handler',
            }),
            toolCallId: llmCall.id,
          });
          continue;
        }

        let confirmed: boolean;
        const confirmAbort = abortRace(signal);
        try {
          // A confirmation UI that unmounts with its provider never answers,
          // so the abort has to be able to end this wait on its own.
          confirmed = await Promise.race([
            options.onConfirm({
              toolName: llmCall.name,
              args: value,
              description: toolDef.description,
              signal,
            }),
            confirmAbort.promise,
          ]);
        } catch (error) {
          // A confirmation UI that unmounts on cancel rejects rather than
          // answering, which is a cancel and not a tool failure.
          if (isAbortError(error) || signal?.aborted) {
            return cancelForAbort(llmCall.name, value, llmCall.id);
          }

          const errorMessage = describeError(error);
          record({
            toolName: llmCall.name,
            args: value,
            result: errorMessage,
            status: 'error',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: errorMessage }),
            toolCallId: llmCall.id,
            isError: true,
          });
          continue;
        } finally {
          confirmAbort.release();
        }

        // Confirmation can take arbitrarily long, so the answer may arrive
        // after the interaction was cancelled. It is stale either way.
        if (signal?.aborted) {
          return cancelForAbort(llmCall.name, value, llmCall.id);
        }

        if (!confirmed) {
          record({
            toolName: llmCall.name,
            args: value,
            result: 'Tool execution cancelled by user',
            status: 'cancelled',
          });
          messages.push({
            role: 'tool',
            content: JSON.stringify({
              status: 'cancelled',
              reason: 'User denied',
            }),
            toolCallId: llmCall.id,
          });
          continue;
        }
      }

      // Only the handler and the serialization run inside the try. Reporting
      // happens after it, so a throwing callback cannot trigger a second
      // report through the catch.
      let outcome: ToolCallOutcome;
      const handlerAbort = abortRace(signal);
      try {
        // A handler that never forwards the signal can still run forever, so
        // the abort ends the wait even though the work itself carries on.
        const result = await Promise.race([
          toolDef.handler(value, { signal }),
          handlerAbort.promise,
        ]);

        // Serialized before anything is recorded: a result the transcript
        // cannot carry is a failed call, not a success with a missing message.
        let content: string;
        try {
          content = JSON.stringify({ result });
        } catch (error) {
          throw new Error(
            `Tool result is not serializable: ${describeError(error)}`,
          );
        }

        outcome = { kind: 'success', result, content };
      } catch (error) {
        // A handler that forwarded the signal rejects on cancel, which is the
        // interaction ending rather than the tool failing.
        outcome =
          isAbortError(error) && signal?.aborted
            ? { kind: 'cancelled' }
            : { kind: 'error', message: describeError(error) };
      } finally {
        handlerAbort.release();
      }

      if (outcome.kind === 'cancelled') {
        return cancelForAbort(llmCall.name, value, llmCall.id);
      }

      if (outcome.kind === 'error') {
        record({
          toolName: llmCall.name,
          args: value,
          result: outcome.message,
          status: 'error',
        });
        messages.push({
          role: 'tool',
          content: JSON.stringify({ error: outcome.message }),
          toolCallId: llmCall.id,
          isError: true,
        });
        continue;
      }

      const status = toolDef.confirm ? 'confirmed' : 'success';

      if (debug) {
        console.log(`[react-observer-agent] Tool "${llmCall.name}" executed:`, {
          status,
          result: outcome.result,
        });
      }

      record({
        toolName: llmCall.name,
        args: value,
        result: outcome.result,
        status,
      });
      messages.push({
        role: 'tool',
        content: outcome.content,
        toolCallId: llmCall.id,
      });
    }

    // The next turn carries the tool results back to the model.
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

  // An empty assistant message is not a turn, and some providers reject it on
  // replay.
  if (finalMessage !== '') {
    messages.push({
      role: 'assistant',
      content: finalMessage,
      providerData: finalProviderData,
    });
  }

  return {
    response: {
      message: finalMessage,
      toolCalls: allToolCalls,
      error: stopError,
      usage: usage.total(),
    },
    messages,
  };
}
