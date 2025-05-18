import type {
  AgentOptions,
  AgentResponse,
  ConversationMessage,
  LLMToolDefinition,
  ModelAdapter,
  PermissionsConfig,
  StateSource,
  ToolCallResult,
  ToolDefinition,
} from '../types';
import { createStateSnapshot } from '../state/createStateSnapshot';
import { filterTools } from '../permissions/filterTools';
import { validateToolCall } from '../permissions/validateToolCall';

const DEFAULT_MAX_TURNS = 5;

interface ExecutionContext {
  model: ModelAdapter;
  state: StateSource;
  tools: ToolDefinition[];
  permissions: PermissionsConfig;
  options?: AgentOptions;
  conversationHistory: ConversationMessage[];
}

export async function executeAgentLoop(
  message: string,
  ctx: ExecutionContext,
): Promise<AgentResponse> {
  const { model, state, tools, permissions, options } = ctx;
  const debug = options?.debug ?? false;
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;

  // 1. Resolve & filter state
  const stateSnapshot = createStateSnapshot(state, permissions.canAccess, debug);

  if (debug) {
    console.log('[react-observer-agent] State snapshot:', stateSnapshot);
  }

  // 2. Filter tools by canExecute
  const allowedTools = filterTools(tools, permissions.canExecute);
  const llmTools: LLMToolDefinition[] = allowedTools
    .filter((t) => t.description && t.parameters)
    .map((t) => ({
      name: t.name,
      description: t.description!,
      parameters: t.parameters!,
    }));

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

  const allToolCalls: ToolCallResult[] = [];
  let turns = 0;
  let finalMessage = '';

  while (turns < maxTurns) {
    turns++;

    if (debug) {
      console.log(`[react-observer-agent] Turn ${turns}/${maxTurns}`);
    }

    // 4. Send to LLM
    const modelRequest = {
      messages,
      tools: llmTools,
      state: stateSnapshot,
      systemPrompt: options?.systemPrompt,
    };

    if (debug) {
      console.log('[react-observer-agent] LLM request:', {
        messageCount: modelRequest.messages.length,
        toolCount: modelRequest.tools.length,
        hasSystemPrompt: !!modelRequest.systemPrompt,
      });
    }

    const modelResponse = await model.sendMessage(modelRequest);

    if (debug) {
      console.log('[react-observer-agent] LLM response:', {
        content: modelResponse.content?.slice(0, 200),
        toolCalls: modelResponse.toolCalls?.map((tc) => tc.name),
      });
    }

    // 5a. Text-only response
    if (!modelResponse.toolCalls || modelResponse.toolCalls.length === 0) {
      finalMessage = modelResponse.content ?? '';
      break;
    }

    // 5b. Has tool calls — process them
    // Add assistant message with tool calls to conversation
    messages.push({
      role: 'assistant',
      content: modelResponse.content ?? '',
      toolCalls: modelResponse.toolCalls,
    });

    for (const llmCall of modelResponse.toolCalls) {
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

      // ii. Confirmation flow
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
            result: 'Tool execution cancelled — no confirmation handler provided',
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

      // iii. Execute tool
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

  if (turns >= maxTurns && !finalMessage) {
    if (debug) {
      console.warn(`[react-observer-agent] Max turns (${maxTurns}) reached`);
    }
    finalMessage = '';
  }

  return {
    message: finalMessage,
    toolCalls: allToolCalls,
  };
}
