import React, { createContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentContext,
  AgentResponse,
  AIAgentProviderProps,
  ConversationEntry,
} from '../types';
import { validateToolNames } from '../tools/validateToolNames';

export const AgentContextValue = createContext<AgentContext | null>(null);

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

  // Validate tool name uniqueness on mount
  useEffect(() => {
    validateToolNames(tools);
  }, [tools]);

  const clearHistory = useCallback(() => {
    setHistory([]);
    setLastResponse(null);
  }, []);

  const send = useCallback(async (message: string): Promise<AgentResponse> => {
    setIsProcessing(true);

    const userEntry: ConversationEntry = {
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    setHistory((prev) => [...prev, userEntry]);

    try {
      // Stub response — real execution loop will be implemented in Phase 7
      const response: AgentResponse = {
        message: '',
        toolCalls: [],
      };

      const assistantEntry: ConversationEntry = {
        role: 'assistant',
        content: response.message,
        toolCalls: response.toolCalls,
        timestamp: Date.now(),
      };

      setHistory((prev) => [...prev, assistantEntry]);
      setLastResponse(response);
      return response;
    } catch (error) {
      const agentError = {
        message: error instanceof Error ? error.message : 'Unknown error',
        cause: error,
      };
      const errorResponse: AgentResponse = {
        message: '',
        toolCalls: [],
        error: agentError,
      };
      setLastResponse(errorResponse);
      optionsRef.current?.onError?.(agentError);
      return errorResponse;
    } finally {
      setIsProcessing(false);
    }
  }, []);

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
