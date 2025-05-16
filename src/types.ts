// JSON Schema type (subset used for tool parameters)
export type JSONSchema = Record<string, unknown>;

// --- Tool Types ---

export interface ToolOptions {
  description?: string;
  parameters?: JSONSchema;
  confirm?: boolean;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  handler: (args: TArgs) => unknown | Promise<unknown>;
  description?: string;
  parameters?: JSONSchema;
  confirm: boolean;
}

// --- Conversation Types ---

export interface ToolCallResult {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'success' | 'error' | 'denied' | 'confirmed' | 'cancelled';
}

export interface ConversationEntry {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[];
  timestamp: number;
}

// --- Agent Response ---

export interface AgentError {
  message: string;
  code?: string;
  cause?: unknown;
}

export interface AgentResponse {
  message: string;
  toolCalls: ToolCallResult[];
  error?: AgentError;
}

// --- Agent Context (useAgent return type) ---

export interface AgentContext {
  send: (message: string) => Promise<AgentResponse>;
  isProcessing: boolean;
  history: ConversationEntry[];
  clearHistory: () => void;
  lastResponse: AgentResponse | null;
}

// --- Permissions ---

export interface PermissionsConfig {
  canAccess: string[];
  canExecute: string[];
}

// --- Model Adapter ---

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ModelRequest {
  messages: ConversationMessage[];
  tools: LLMToolDefinition[];
  state: Record<string, unknown>;
  systemPrompt?: string;
}

export interface ModelResponse {
  content: string | null;
  toolCalls?: LLMToolCall[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface ModelAdapter {
  sendMessage(request: ModelRequest): Promise<ModelResponse>;
}

// --- Provider Props ---

export type StateSource =
  | Record<string, unknown>
  | (() => Record<string, unknown>);

export interface PendingToolCall {
  toolName: string;
  args: unknown;
  description?: string;
}

export interface ToolCallEvent {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolCallResult['status'];
}

export interface AgentOptions {
  debug?: boolean;
  maxTurns?: number;
  systemPrompt?: string;
  onError?: (error: AgentError) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onConfirm?: (call: PendingToolCall) => Promise<boolean>;
}

export interface AIAgentProviderProps {
  model: ModelAdapter;
  state: StateSource;
  tools: ToolDefinition[];
  permissions: PermissionsConfig;
  options?: AgentOptions;
  children: React.ReactNode;
}

// --- Adapter Config ---

export interface OpenAIAdapterConfig {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  temperature?: number;
  headers?: Record<string, string>;
}
