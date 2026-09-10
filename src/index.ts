// Tools
export { registerTool } from './tools/registerTool';
export { validateToolNames } from './tools/validateToolNames';
export { validateToolArgs } from './tools/validateToolArgs';

// Provider
export { AIAgentProvider } from './provider/AIAgentProvider';
export { useAgent } from './provider/useAgent';

// Permissions
export { filterState } from './permissions/filterState';
export { filterTools } from './permissions/filterTools';
export { validateToolCall } from './permissions/validateToolCall';

// Adapters
export { openAIAdapter } from './adapters/openai';
export { claudeAdapter } from './adapters/claude';
export { AdapterError } from './adapters/AdapterError';

// Types
export type {
  ToolDefinition,
  AnyToolDefinition,
  ToolOptions,
  ToolContext,
  ToolHandler,
  StandardSchemaV1,
  StandardSchemaProps,
  StandardSchemaResult,
  StandardSchemaIssue,
  InferSchemaOutput,
  AIAgentProviderProps,
  PermissionsConfig,
  AgentOptions,
  AgentContext,
  AgentResponse,
  AgentEvent,
  AgentErrorCode,
  ToolCallResult,
  ToolCallStatus,
  TokenUsage,
  ConversationEntry,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  StopReason,
  StateSource,
  PendingToolCall,
  ToolCallEvent,
  SendOptions,
  AgentError,
  JSONSchema,
  LLMToolCall,
  LLMToolDefinition,
  ConversationMessage,
  OpenAIAdapterConfig,
  ClaudeAdapterConfig,
} from './types';
export type { ToolArgsValidation } from './tools/validateToolArgs';
