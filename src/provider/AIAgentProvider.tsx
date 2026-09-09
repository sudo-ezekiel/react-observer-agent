import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentContext,
  AgentError,
  AgentResponse,
  AIAgentProviderProps,
  ConversationEntry,
  ConversationMessage,
  SendOptions,
} from '../types';
import { AdapterError } from '../adapters/AdapterError';
import { validateToolNames } from '../tools/validateToolNames';
import { executeAgentLoop } from './executeAgentLoop';

export const AgentContextValue = createContext<AgentContext | null>(null);

const noop = (): void => {};

export function AIAgentProvider({
  model,
  state,
  tools,
  permissions,
  options,
  children,
}: AIAgentProviderProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [history, setHistory] = useState<ConversationEntry[]>([]);
  const [lastResponse, setLastResponse] = useState<AgentResponse | null>(null);

  // Store latest props in refs so send() always sees current values
  const modelRef = useRef(model);
  const stateRef = useRef(state);
  const toolsRef = useRef(tools);
  const permissionsRef = useRef(permissions);
  const optionsRef = useRef(options);

  modelRef.current = model;
  stateRef.current = state;
  toolsRef.current = tools;
  permissionsRef.current = permissions;
  optionsRef.current = options;

  useEffect(() => {
    validateToolNames(tools);
  }, [tools]);

  // The LLM-facing transcript, kept separately from the user-facing history so
  // structured tool calls survive across interactions.
  const transcriptRef = useRef<ConversationMessage[]>([]);

  // Tail of the interaction queue. Overlapping send() calls would otherwise
  // start from the same transcript and interleave their history entries.
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  // Calls that have been made but not settled. isProcessing is derived from it
  // so it does not flicker false between two queued interactions.
  const pendingRef = useRef(0);

  // Bumped by clearHistory. An interaction that started before the reset must
  // not write its transcript back over the cleared one.
  const generationRef = useRef(0);

  const clearHistory = useCallback(() => {
    generationRef.current++;
    setHistory([]);
    setLastResponse(null);
    transcriptRef.current = [];
  }, []);

  const runInteraction = useCallback(async (
    message: string,
    sendOptions?: SendOptions,
  ): Promise<AgentResponse> => {
    const generation = generationRef.current;

    // Appended here rather than in send() so the entry lands in queue order,
    // keeping history alternating user, assistant.
    const userEntry: ConversationEntry = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    setHistory((prev) => [...prev, userEntry]);

    let response: AgentResponse;

    try {
      const loop = await executeAgentLoop(message, {
        model: modelRef.current,
        state: stateRef.current,
        tools: toolsRef.current,
        permissions: permissionsRef.current,
        options: optionsRef.current,
        conversationHistory: transcriptRef.current,
        signal: sendOptions?.signal,
      });

      response = loop.response;

      // clearHistory() during the interaction means the user asked for this
      // conversation to be gone, so nothing it produced is written back. The
      // user entry appended above went with the clear.
      if (generation === generationRef.current) {
        // An abort can land between an assistant message and the tool results
        // answering it. Providers reject that shape, so the partial turn is
        // dropped rather than replayed.
        if (response.error?.code !== 'ABORTED') {
          transcriptRef.current = loop.messages;
        }

        const assistantEntry: ConversationEntry = {
          role: 'assistant',
          content: response.message,
          toolCalls: response.toolCalls,
          timestamp: Date.now(),
        };

        if (response.error) {
          assistantEntry.error = response.error;
        }

        setHistory((prev) => [...prev, assistantEntry]);
        setLastResponse(response);
      }
    } catch (error) {
      const agentError: AgentError = error instanceof AdapterError
        ? {
            message: error.message,
            code: 'ADAPTER_ERROR',
            status: error.status,
            cause: error,
          }
        : {
            message: error instanceof Error ? error.message : 'Unknown error',
            cause: error,
          };

      response = {
        message: '',
        toolCalls: [],
        error: agentError,
      };

      // The interaction still started, so it still gets its assistant entry
      // and history keeps alternating user, assistant.
      if (generation === generationRef.current) {
        setHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '',
            toolCalls: [],
            error: agentError,
            timestamp: Date.now(),
          },
        ]);
        setLastResponse(response);
      }
    }

    // The loop reports failures it recovered from by returning them, rather
    // than throwing, so the error handler still needs to hear about them.
    // A user-initiated cancel is not an application error.
    //
    // Reported here, past the catch, so a consumer callback that throws is not
    // mistaken for a failure of the interaction: it would otherwise append a
    // second assistant entry, overwrite lastResponse and fire onError again.
    // The throw travels out of send() with the state writes already done.
    if (response.error && response.error.code !== 'ABORTED') {
      optionsRef.current?.onError?.(response.error);
    }

    return response;
  }, []);

  const send = useCallback((
    message: string,
    sendOptions?: SendOptions,
  ): Promise<AgentResponse> => {
    pendingRef.current++;
    setIsProcessing(pendingRef.current > 0);

    const interaction = queueRef.current.then(() => runInteraction(message, sendOptions));
    // The tail swallows failures so one broken interaction cannot stall every
    // call queued behind it. The caller still sees what `interaction` settles with.
    queueRef.current = interaction.then(noop, noop);

    return interaction.finally(() => {
      pendingRef.current--;
      setIsProcessing(pendingRef.current > 0);
    });
  }, [runInteraction]);

  const contextValue = useMemo<AgentContext>(
    () => ({
      send,
      isProcessing,
      history,
      clearHistory,
      lastResponse,
    }),
    [send, isProcessing, history, clearHistory, lastResponse],
  );

  return (
    <AgentContextValue.Provider value={contextValue}>
      {children}
    </AgentContextValue.Provider>
  );
}
