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

/**
 * A tool definition with its argument type erased. Tools registered with
 * different argument types can only share one array through this type, since
 * handler parameters are contravariant.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDefinition = ToolDefinition<any>;

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

export interface SendOptions {
  /** Cancels the interaction. The pending response resolves with an ABORTED error. */
  signal?: AbortSignal;
}

export interface AgentContext {
  send: (message: string, options?: SendOptions) => Promise<AgentResponse>;
  isProcessing: boolean;
  history: ConversationEntry[];
  clearHistory: () => void;
  lastResponse: AgentResponse | null;
}

// --- Permissions ---

export interface PermissionsConfig {
  canAccess: string[];
  canExecute: string[];
  stateDescriptions?: Record<string, string>;
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
  stateManifest?: { key: string; description: string }[];
  /** Adapters should forward this to their transport so requests cancel in flight. */
  signal?: AbortSignal;
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

/**
 * Application state, as an object read on each access or a getter called on
 * each access. Any object shape is accepted: store interfaces rarely carry the
 * index signature that `Record<string, unknown>` would demand.
 */
export type StateSource = object | (() => object);

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
  tools: AnyToolDefinition[];
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
