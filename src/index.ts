// Tools
export { registerTool } from './tools/registerTool';
export { validateToolNames } from './tools/validateToolNames';

// Provider
export { AIAgentProvider } from './provider/AIAgentProvider';
export { useAgent } from './provider/useAgent';

// Types
export type {
  ToolDefinition,
  ToolOptions,
  AIAgentProviderProps,
  PermissionsConfig,
  AgentOptions,
  AgentContext,
  AgentResponse,
  ToolCallResult,
  ConversationEntry,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  StateSource,
  PendingToolCall,
  ToolCallEvent,
  AgentError,
  JSONSchema,
  LLMToolCall,
  LLMToolDefinition,
  ConversationMessage,
} from './types';
