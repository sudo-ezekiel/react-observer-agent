import { useContext } from 'react';
import type { AgentContext } from '../types';
import { AgentContextValue } from './AIAgentProvider';

export function useAgent(): AgentContext {
  const context = useContext(AgentContextValue);
  if (!context) {
    throw new Error(
      'useAgent() must be used within an <AIAgentProvider>. ' +
        'Wrap your component tree with <AIAgentProvider> to use this hook.',
    );
  }
  return context;
}
