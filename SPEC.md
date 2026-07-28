# react-observer-agent Technical Specification

> Version: 0.2.0
> Author: Ezekiel
> Status: Living document. Describes the library as implemented at v0.2.0.
> Supersedes: 0.1.0-draft (March 29, 2026)
> Last updated: July 28, 2026

---

## 1. Overview

`react-observer-agent` is a React library that lets an AI agent observe application state, understand user context, and execute pre-defined actions through a declarative provider pattern with built-in permission boundaries.

### Design principles

- **Declarative**: configuration via JSX props, not imperative wiring.
- **Safe by default**: nothing is readable or executable unless explicitly allowed.
- **Pull, don't push**: the agent requests the state it needs instead of receiving a full snapshot on every call.
- **Adapter-agnostic**: swap LLM backends without changing app code.
- **Minimal surface area**: small API, composable internals.
- **Zero lock-in**: works with any state manager (Zustand, Redux, vanilla React).

### Architecture at a glance

```
 <AIAgentProvider model state tools permissions options>
        |
        |  useAgent().send("What's in my cart?")
        v
 +-------------------- executeAgentLoop ---------------------+
 |                                                           |
 |  1. Build state manifest        (canAccess + descriptions)|
 |  2. Filter tools                (canExecute)              |
 |  3. Inject __readState tool     (if manifest non-empty)   |
 |  4. Turn loop (<= maxTurns):                              |
 |       model.sendMessage(...)  ----->  ModelAdapter        |
 |       <- text only?  break                                |
 |       <- __readState?  resolve + filter keys, feed back   |
 |       <- user tool?    validate -> confirm? -> execute    |
 |                        feed result back, next turn        |
 +-----------------------------------------------------------+
        |
        v
 AgentResponse { message, toolCalls, usage?, error? }  (readState excluded)
```

The defining choice is **pull-based state**. The LLM never receives state values upfront. It receives a manifest (key names and descriptions) in the system prompt and pulls specific values on demand through an internal `__readState` tool. This keeps token usage proportional to what the agent actually needs and keeps unread state out of the request entirely. See section 4.2 and [docs/internals.md](docs/internals.md).

---

## 2. Security model

The library treats the LLM as an untrusted planner operating inside a capability sandbox:

1. **Whitelist permissions.** `canAccess` and `canExecute` are allowlists. A key or tool not listed does not exist from the agent's point of view, and the executor independently rejects it if the model hallucinates the name (defense in depth, section 4.3).
2. **Human confirmation.** Tools registered with `confirm: true` require the app's `onConfirm` handler to approve each invocation. Use this for anything irreversible or user-visible (purchases, deletions, navigation away from unsaved work).
3. **Untrusted state values.** State often contains user-generated content (product reviews, messages, profile fields). Once serialized into the conversation, that content can attempt prompt injection. The permission and confirmation layers are the backstop: an injected instruction can, at worst, invoke whitelisted tools, and confirmed tools still require a human yes.
4. **API keys stay off the client in production.** See the adapter security note in section 3.4.

---

## 3. Public API

### 3.1 `registerTool(name, handler, options?)`

Creates a validated tool definition the agent is allowed to invoke.

```ts
function registerTool<TArgs = unknown>(
  name: string,
  handler: (args: TArgs) => unknown | Promise<unknown>,
  options?: ToolOptions
): ToolDefinition<TArgs>;

interface ToolOptions {
  description?: string;    // Shown to the LLM; required for the tool to be visible to it
  parameters?: JSONSchema; // JSON Schema for the arguments; defaults to an empty object schema
  confirm?: boolean;       // Require user confirmation before execution (default: false)
}

interface ToolDefinition<TArgs = unknown> {
  name: string;
  handler: (args: TArgs) => unknown | Promise<unknown>;
  description?: string;
  parameters?: JSONSchema;
  confirm: boolean;
}
```

**Behavior**

- `name` must be unique across all tools passed to a single provider. Uniqueness is enforced at the provider level, not at registration time, so tools can be composed from independent modules without global coordination. The provider throws on mount when it detects duplicates.
- Names beginning with `__` are **reserved** for internal tools (`__readState` today). The provider rejects user tools with reserved names on mount.
- `handler` runs when the agent invokes the tool. Its return value is serialized and fed back to the LLM, so return something meaningful (`"Added Headphones to cart"`) rather than `undefined`.
- **LLM visibility rule:** a tool is only exposed to the model when it has a `description`. When `parameters` is omitted, the provider substitutes the empty object schema `{ "type": "object", "properties": {} }`. A tool hidden for lacking a description is still executable if the model names it, since `canExecute` is the authority.
- `parameters` is enforced at runtime: arguments are validated against it before the handler runs, and before the confirmation prompt (section 4.4). Validation covers a subset of JSON Schema (`type`, `properties`, `required`, `items`, `enum`) and ignores keywords outside it, so a richer schema validates on the parts the library understands rather than failing outright. Handlers should still treat `args` as untrusted, since unvalidated keywords pass through.
- `confirm: true` routes execution through the provider's `onConfirm` callback (section 4.4).

---

### 3.2 `<AIAgentProvider>`

React context provider that wires state, tools, model, and permissions together.

```tsx
// Any object shape: store interfaces rarely carry the index signature that
// `Record<string, unknown>` would demand.
type StateSource = object | (() => object);

// A ToolDefinition with its argument type erased, so tools registered with
// different argument types can share one array.
type AnyToolDefinition = ToolDefinition<any>;

interface AIAgentProviderProps {
  model: ModelAdapter;
  state: StateSource;
  tools: AnyToolDefinition[];
  permissions: PermissionsConfig;
  options?: AgentOptions;
  children: React.ReactNode;
}

interface PermissionsConfig {
  canAccess: string[];                        // State keys the agent may read
  canExecute: string[];                       // Tool names the agent may invoke
  stateDescriptions?: Record<string, string>; // Optional per-key descriptions for the manifest
}

interface AgentOptions {
  debug?: boolean;                            // Verbose console logging (default: false)
  maxTurns?: number;                          // Max LLM round trips per send() (default: 5)
  systemPrompt?: string;                      // Prepended to the generated state manifest prompt
  onError?: (error: AgentError) => void;      // Called when send() fails
  onToolCall?: (call: ToolCallEvent) => void; // Observer for user-tool outcomes
  onConfirm?: (call: PendingToolCall) => Promise<boolean>; // Approval handler for confirm:true tools
}

interface PendingToolCall {
  toolName: string;
  args: unknown;
  description?: string;
}

interface ToolCallEvent {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'success' | 'error' | 'denied' | 'confirmed' | 'cancelled';
}
```

**Behavior**

- `state` accepts either form:
  - **Object**: read directly each time state is resolved. Works naturally with React state (`state={{ user, cart }}`), since re-renders pass a fresh object.
  - **Getter function**: called each time state is resolved. Works with external stores: `() => useStore.getState()` for Zustand, `() => store.getState()` for Redux.
  - The getter runs **outside React rendering** (inside the async agent loop), so it must not call hooks. Pass `() => useStore.getState()`, never the hook itself (`state={useStore}` throws an invalid hook call when the agent reads state).
- `permissions.canAccess` defines the manifest: only listed keys are advertised to the LLM, and `__readState` requests are filtered to this list.
- `permissions.stateDescriptions` optionally attaches a human-readable description to each manifest key. Missing entries fall back to the key name. Good descriptions let the model pick the right key without reading everything.
- `permissions.canExecute` filters the tool list. A registered tool absent from `canExecute` is never shown to the LLM.
- On mount, the provider validates tool-name uniqueness and throws on duplicates.
- Prop updates take effect on the next `send()`: the provider reads `model`, `state`, `tools`, `permissions`, and `options` through refs, so an in-flight interaction keeps the values it started with.

---

### 3.3 `useAgent()`

Hook for interacting with the agent from anywhere inside the provider tree. Throws when called outside one.

```ts
function useAgent(): AgentContext;

interface SendOptions {
  signal?: AbortSignal; // Cancels the interaction; resolves with an ABORTED error
}

interface AgentContext {
  send: (message: string, options?: SendOptions) => Promise<AgentResponse>;
  isProcessing: boolean;                             // True while an interaction is in flight
  history: ConversationEntry[];                      // Session conversation history
  clearHistory: () => void;                          // Reset history and lastResponse
  lastResponse: AgentResponse | null;                // Most recent response (or error response)
}

interface AgentResponse {
  message: string;              // Agent's final text
  toolCalls: ToolCallResult[];  // User tools invoked during this interaction (all statuses)
  error?: AgentError;           // Present when the interaction failed or was cancelled
  usage?: { promptTokens: number; completionTokens: number }; // Totalled across turns
}

interface ToolCallResult {
  toolName: string;
  args: unknown;
  result: unknown;
  status: 'success' | 'error' | 'denied' | 'confirmed' | 'cancelled';
}

interface ConversationEntry {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[];
  timestamp: number;
}

interface AgentError {
  message: string;
  code?: string;
  cause?: unknown;
}
```

**History semantics**

- The provider records one `user` entry per `send()` and one `assistant` entry per completed response. Tool activity rides on the assistant entry's `toolCalls`; standalone `tool` entries are reserved for future use.
- History is scoped to the provider instance. Unmount clears it; `clearHistory()` clears it manually.
- On each `send()`, the prior LLM-facing transcript is replayed verbatim, including assistant tool calls and the tool results answering them, so the agent can reason about what it already did. The provider keeps this transcript separately from the user-facing `history`.
- An aborted turn is **not** added to the transcript. A cancel can land between an assistant tool call and the result answering it, and providers reject that shape. A turn whose adapter threw is likewise dropped.
- Replayed `__readState` results hold the values read at the time. The manifest instruction tells the model to re-read when it needs current values; `clearHistory()` drops the transcript entirely.
- `__readState` activity never appears in `history`, `AgentResponse.toolCalls`, or `onToolCall` (section 4.2).

---

### 3.4 Model adapters

Adapters normalize different LLM APIs into a single interface.

```ts
interface ModelAdapter {
  sendMessage(request: ModelRequest): Promise<ModelResponse>;
}

interface ModelRequest {
  messages: ConversationMessage[];
  tools: LLMToolDefinition[];                            // Includes __readState when state is accessible
  state: Record<string, unknown>;                        // Deprecated: always {} since the pull refactor
  systemPrompt?: string;                                 // User prompt + generated manifest prompt
  stateManifest?: { key: string; description: string }[]; // Informational; already baked into systemPrompt
  signal?: AbortSignal;                                  // Forward to the transport so requests cancel
}

interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;         // Links a tool message to the call it answers
  toolCalls?: LLMToolCall[];   // Present on assistant messages that requested tools
}

interface ModelResponse {
  content: string | null;      // Text response (null when the model only called tools)
  toolCalls?: LLMToolCall[];   // Requested tool invocations
  usage?: { promptTokens: number; completionTokens: number };
}

interface LLMToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;
}
```

**Adapter contract**

An adapter MUST:

1. Map all three message roles to the provider's native format, preserving order.
2. Serialize `toolCalls` on assistant messages into the provider's native structure (OpenAI: `tool_calls`; Anthropic: `tool_use` blocks). Providers reject tool-result messages that do not follow an assistant message carrying the matching call, so dropping this field breaks every tool round trip.
3. Link tool messages to their originating call via `toolCallId` (OpenAI: `tool_call_id`; Anthropic: `tool_use_id`).
4. Parse tool-call arguments from the wire format into `LLMToolCall.arguments` (JSON-parse with a raw-string fallback for malformed JSON).
5. Throw on network failures, non-2xx responses, and malformed payloads. The provider converts throws into `AgentResponse.error` and invokes `onError`.
6. Treat `state` as dead weight (always `{}`) and `stateManifest` as optional context; the manifest is already injected into `systemPrompt` by the loop.
7. Forward `signal` to the transport, and rethrow an `AbortError` unchanged rather than rewrapping it as a transport failure. The loop identifies cancellation by that error name.

The loop passes a snapshot of `messages`, so an adapter may hold onto it across awaits without observing later turns.

**Built-in and planned adapters**

| Adapter | Status | Notes |
|---------|--------|-------|
| `openAIAdapter` | Shipped | Chat completions with function calling |
| `claudeAdapter` | Shipped (v0.2.0) | Anthropic Messages API with tool use |
| `ollamaAdapter` | Planned | Local models via Ollama |
| Custom | Supported | Implement `ModelAdapter` and pass it to the provider |

```ts
function openAIAdapter(config: OpenAIAdapterConfig): ModelAdapter;

interface OpenAIAdapterConfig {
  apiKey?: string;          // Dev and prototyping only; see security note
  model?: string;           // Default: 'gpt-4o'
  baseURL?: string;         // Proxy endpoint (recommended for production)
  temperature?: number;     // Default: 0.2
  headers?: Record<string, string>; // Extra headers (e.g. auth for your proxy)
}
```

```ts
function claudeAdapter(config: ClaudeAdapterConfig): ModelAdapter;

interface ClaudeAdapterConfig {
  apiKey?: string;          // Dev and prototyping only; see security note
  model?: string;           // Default: 'claude-opus-5'
  baseURL?: string;         // Proxy endpoint (recommended for production)
  maxTokens?: number;       // Required by the API; default: 16000
  headers?: Record<string, string>; // Extra headers, spread last so they win
}
```

Both adapters require either `apiKey` or `baseURL` and throw at initialization when given neither. When `baseURL` already contains the endpoint path (`/chat/completions` for OpenAI, `/v1/messages` for Claude) it is used as-is; otherwise the path is appended.

`claudeAdapter` sends `anthropic-version: 2023-06-01` and, when `apiKey` is set, `x-api-key`. It sends no sampling parameters, which current Claude models reject. Calling the Anthropic API directly from a browser additionally requires that provider's CORS opt-in header; pass it through `headers` (the proxy pattern below avoids the question entirely, and is the recommended production path regardless).

> **Security: API key handling.**
> Passing `apiKey` ships the key to the browser, visible in DevTools and network requests. Acceptable for local development, never for production.
>
> For production, route through your own backend with `baseURL` + `headers`:
>
> ```ts
> const model = openAIAdapter({
>   baseURL: '/api/agent',
>   headers: { Authorization: `Bearer ${sessionToken}` },
> });
> ```
>
> The backend holds the real API key, applies rate limits and auth, and forwards to the LLM provider.

---

## 4. Runtime behavior

### 4.1 Execution loop

`send(message)` runs the following (implemented in `src/provider/executeAgentLoop.ts`):

```
1. Build state manifest from canAccess + stateDescriptions
2. Filter tools by canExecute; map to LLM tool definitions
3. Append __readState to the tool list when the manifest is non-empty
4. System prompt = options.systemPrompt + generated manifest prompt
5. Turn loop, at most maxTurns iterations (default 5):
   a. If the signal is aborted, stop and return an ABORTED error
   b. model.sendMessage({ messages, tools, systemPrompt, stateManifest, signal })
      An AbortError from the adapter also ends the loop as ABORTED
   c. Accumulate reported token usage
   d. Text-only response: capture as final message, exit loop
   e. Tool calls: append the assistant message, then for each call:
      - stop first if the signal is aborted, before any further side effect
      - __readState: filter requested keys to canAccess, snapshot state,
        append result as a tool message (internal, not surfaced)
      - name not in canExecute: append error result, status 'denied'
      - arguments failing the parameters schema: append the validation
        error, status 'error'; the handler does not run
      - confirm:true: run onConfirm; on deny or missing handler,
        append cancelled result, status 'cancelled'
      - otherwise execute handler; append result,
        status 'success' | 'confirmed' | 'error'
   f. Next turn with the grown message list
6. Return the response plus the message list, for replay on the next send
```

When `maxTurns` is exhausted while the model is still calling tools, the loop returns an empty `message`, whatever `toolCalls` accumulated, and `error.code: 'MAX_TURNS'` (plus a debug warning). A cancelled interaction returns `error.code: 'ABORTED'` the same way. Neither throws.

Exceptions thrown anywhere in the loop (adapter failures included) are caught by the provider, converted to an `AgentResponse` with `error` set, stored in `lastResponse`, and passed to `onError`. `send()` resolves rather than rejects. Errors the loop returns rather than throws also reach `onError`, with one exception: `ABORTED` does not, since a cancel is a caller decision rather than an application failure.

### 4.2 Pull-based state and `__readState`

State is never pushed into the prompt. Instead:

1. **Manifest.** Each interaction maps `canAccess` to `{ key, description }` pairs, using `stateDescriptions` with the key name as fallback.
2. **Prompt injection.** The manifest is rendered into the system prompt with an instruction to read only relevant keys via `__readState`.
3. **Internal tool.** `__readState` is appended to the LLM tool list whenever the manifest is non-empty:

```json
{
  "name": "__readState",
  "description": "Read specific keys from the application state. Only request keys you need.",
  "parameters": {
    "type": "object",
    "properties": {
      "keys": { "type": "array", "items": { "type": "string" }, "description": "State keys to read" }
    },
    "required": ["keys"]
  }
}
```

4. **Enforcement on read.** Requested keys are intersected with `canAccess`; unauthorized keys are silently dropped. The state source is resolved at call time (`typeof state === 'function' ? state() : state`), filtered to the allowed keys, and serialized.
5. **Serialization safety.** Functions, symbols, bigints, and values that fail `JSON.stringify` (circular references) are stripped, with a warning in debug mode.
6. **Invisibility.** `__readState` never appears in `AgentResponse.toolCalls`, `onToolCall`, or `history`. It exists only inside the LLM-facing message list so the model can reason across turns.

Rationale, trade-offs, and a worked example live in [docs/internals.md](docs/internals.md).

### 4.3 Permission enforcement

Permissions are enforced at two layers:

1. **Visibility (before the LLM call).** The model only ever sees manifest keys from `canAccess` and tools from `canExecute`. The agent cannot request what it cannot see.
2. **Execution (after the LLM response).** Tool names are re-validated against `canExecute` before execution, and `__readState` requests are re-filtered against `canAccess`. A hallucinated or injected name is rejected with status `'denied'`.

### 4.4 Confirmation flow

Argument validation runs first, so a malformed call is rejected before anyone is asked to approve it.

For a tool registered with `confirm: true`:

- With an `onConfirm` handler: the loop awaits `onConfirm({ toolName, args, description })`. Resolving `true` executes the handler (final status `'confirmed'`); resolving `false` skips it (status `'cancelled'`, the LLM is told the user denied it).
- Without a handler: the tool is skipped with status `'cancelled'` and a debug warning. Confirmation is never silently bypassed.

The consumer owns the UI: modal, toast, inline card, `window.confirm`, anything that eventually yields a boolean.

### 4.5 Tool call statuses

| Status | Meaning | Fed back to LLM as |
|--------|---------|--------------------|
| `success` | Tool executed normally (no confirmation required) | `{ result }` |
| `confirmed` | `confirm: true` tool approved and executed | `{ result }` |
| `cancelled` | `confirm: true` tool denied, or no `onConfirm` handler | `{ status: 'cancelled', reason }` |
| `denied` | Name failed the `canExecute` check | `{ error }` |
| `error` | Handler threw, or arguments failed the `parameters` schema | `{ error }` |

`onToolCall` fires for every user-tool outcome above. It does not fire for `__readState`, nor for the edge case where a name passes `canExecute` but no matching tool definition exists (that call is recorded as `'denied'` in `toolCalls` only).

### 4.6 Debug logging

With `options.debug: true`, the loop logs manifest keys, the exposed tool list, per-turn request and response summaries, `__readState` requested vs. allowed keys with results, and tool execution outcomes, all prefixed `[react-observer-agent]`. Full detail in [docs/internals.md](docs/internals.md).

---

## 5. Usage

### 5.1 Installation

```bash
npm install react-observer-agent
```

### 5.2 Register tools

```ts
// tools.ts
import { registerTool } from 'react-observer-agent';
import { useStore } from './store';

export const tools = [
  registerTool('navigateTo', (args: { path: string }) => {
    window.history.pushState(null, '', args.path);
    return `Navigated to ${args.path}`;
  }, {
    description: 'Navigate to a page in the app',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  }),

  registerTool('addToCart', (args: { productId: string }) => {
    useStore.getState().addToCart(args.productId);
    return `Added ${args.productId} to cart`;
  }, {
    description: 'Add a product to the shopping cart',
    parameters: {
      type: 'object',
      properties: { productId: { type: 'string' } },
      required: ['productId'],
    },
    confirm: true, // user must approve each call
  }),

  registerTool('clearCart', () => {
    useStore.getState().clearCart();
    return 'Cart cleared';
  }, {
    description: 'Remove all items from the cart',
    // parameters may be omitted; the empty object schema is substituted
    confirm: true,
  }),
];
```

### 5.3 Wrap your app

With an external store (getter function):

```tsx
// App.tsx
import { AIAgentProvider, openAIAdapter } from 'react-observer-agent';
import { useStore } from './store';
import { tools } from './tools';

// Production: route through your backend proxy
const model = openAIAdapter({
  baseURL: '/api/agent',
  headers: { Authorization: `Bearer ${getSessionToken()}` },
});

// Or, against Claude. The provider is adapter-agnostic, so nothing else changes:
// const model = claudeAdapter({
//   baseURL: '/api/agent',
//   headers: { Authorization: `Bearer ${getSessionToken()}` },
// });

export default function App() {
  return (
    <AIAgentProvider
      model={model}
      state={() => {
        const { user, cart, products } = useStore.getState();
        return { user, cart, products };
      }}
      tools={tools}
      permissions={{
        canAccess: ['user', 'cart', 'products'],
        canExecute: ['navigateTo', 'addToCart', 'clearCart'],
        stateDescriptions: {
          user: 'Current logged-in user profile',
          cart: 'Shopping cart items and quantities',
          products: 'Available product catalog with IDs, names, and prices',
        },
      }}
      options={{
        debug: true,
        maxTurns: 5,
        onConfirm: async (call) =>
          window.confirm(`Allow agent to run "${call.toolName}"?`),
      }}
    >
      <Router />
    </AIAgentProvider>
  );
}
```

With vanilla React state (plain object):

```tsx
function App() {
  const [user, setUser] = useState(null);
  const [cart, setCart] = useState([]);

  return (
    <AIAgentProvider
      model={model}
      state={{ user, cart }} // fresh object on each render
      tools={tools}
      permissions={{ canAccess: ['user', 'cart'], canExecute: ['clearCart'] }}
    >
      <MyApp />
    </AIAgentProvider>
  );
}
```

### 5.4 Interact from any component

```tsx
// ChatPanel.tsx
import { useState } from 'react';
import { useAgent } from 'react-observer-agent';

function ChatPanel() {
  const { send, isProcessing, history } = useAgent();
  const [input, setInput] = useState('');

  const handleSend = async () => {
    await send(input);
    setInput('');
  };

  return (
    <div>
      {history.map((entry, i) => (
        <div key={i} className={entry.role}>{entry.content}</div>
      ))}
      {isProcessing && <Spinner />}
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={handleSend} disabled={isProcessing}>Send</button>
    </div>
  );
}
```

### 5.5 What happens under the hood

**User asks: "What's in my cart?"**

1. The loop advertises the manifest (`user`, `cart`, `products` with descriptions) and the `__readState` tool.
2. The LLM calls `__readState({ keys: ["cart"] })`.
3. The loop verifies `cart` is in `canAccess`, resolves the state source, and returns `{ "cart": [...] }` as the tool result.
4. The LLM answers: "You have 2 items in your cart: ...". The readState round trip is invisible to the consumer.

**User asks: "Add the blue sneakers to my cart"**

1. The LLM may first call `__readState({ keys: ["products"] })` to find the ID.
2. It then calls `addToCart({ productId: "blue-sneakers-123" })`.
3. `confirm: true` routes through `onConfirm`; on approval the handler runs and the result is fed back (status `'confirmed'`).
4. The LLM closes with: "Done! Blue sneakers added to your cart."
5. On denial, the tool is skipped with status `'cancelled'` and the LLM is told the user declined.

---

## 6. Package exports

Mirrors `src/index.ts`:

```ts
// Functions and components
export { registerTool } from './tools/registerTool';
export { validateToolNames } from './tools/validateToolNames';
export { AIAgentProvider } from './provider/AIAgentProvider';
export { useAgent } from './provider/useAgent';
export { filterState } from './permissions/filterState';
export { filterTools } from './permissions/filterTools';
export { validateToolCall } from './permissions/validateToolCall';
export { openAIAdapter } from './adapters/openai';
export { claudeAdapter } from './adapters/claude';

// Types
export type {
  ToolDefinition, AnyToolDefinition, ToolOptions,
  AIAgentProviderProps, PermissionsConfig, AgentOptions,
  AgentContext, AgentResponse, ToolCallResult, ConversationEntry,
  ModelAdapter, ModelRequest, ModelResponse,
  StateSource, PendingToolCall, ToolCallEvent, AgentError, SendOptions,
  JSONSchema, LLMToolCall, LLMToolDefinition, ConversationMessage,
  OpenAIAdapterConfig, ClaudeAdapterConfig,
} from './types';
```

`validateToolNames`, `filterState`, `filterTools`, and `validateToolCall` are exported as building blocks for testing and custom wiring; typical apps never call them directly.

---

## 7. Known divergences (spec vs. code)

None. The four divergences recorded against v0.1.0 (adapter tool-call serialization, tool visibility defaults, the reserved `__` prefix, and the example app's state source) were all fixed in v0.2.0; see [CHANGELOG.md](CHANGELOG.md). This section stays as the place to record future gaps between this spec and shipped behavior.

---

## 8. Implementation status and roadmap

### Done (v0.2.0)

Everything in sections 3 and 4 is implemented and covered by tests: the tool registry with reserved-prefix and uniqueness validation, pull-based state via the manifest and `__readState`, the two-layer permission model, runtime argument validation, the confirmation flow, abort support, structured conversation replay, usage aggregation, and both the OpenAI and Claude adapters.

### Next (v0.3 candidates, rough priority order)

1. `ollamaAdapter` for local models.
2. Streaming responses, which need a `ModelAdapter` extension and an incremental `useAgent` surface.
3. Deeper argument validation (`additionalProperties`, numeric and length constraints, `$ref`), or an opt-in hook for a real JSON Schema validator without taking on the dependency by default.
4. Transcript compaction, so long sessions stay under the model's context window instead of growing unbounded until `clearHistory()`.
5. Per-tool permission scoping beyond the flat `canExecute` list.

### Non-goals (for now)

- **DOM awareness / page context mapping**: deferred until the core is stable.
- **Automatic state detection**: too much magic; the explicit `state` prop is sufficient.
- **Multi-agent orchestration**: out of scope.
- **Persistent memory**: session memory only, no storage integration.
- **Built-in rate limiting**: the backend proxy pattern (section 3.4) handles this server-side, where it is reliable.

---

## 9. Technical decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript (strict) | Type safety, better DX |
| Build | tsup | Fast, zero-config, dual CJS/ESM |
| Test | Vitest + React Testing Library | Fast, ESM-native, good React support |
| Lint | ESLint + Prettier | Standard tooling |
| React version | >=18 (peer dep) | Hooks, concurrent features |
| State access | Pull-based via `__readState` | Token cost scales with what the agent reads, not with app state size; unread state never leaves the client |
| State source | Object or getter prop | Object for React state; getter for external stores |
| Permissions | Whitelist-only | Deny unless explicitly allowed |
| LLM communication | Adapter pattern | Decouples the core from any specific provider |
| Reserved tool namespace | `__` prefix | Internal tools can be added without colliding with user tools |
| Argument validation | Hand-written JSON Schema subset | Keeps the package dependency free; unknown keywords pass through rather than failing |
| Cancellation | `AbortSignal` on `send()` | Standard platform primitive, forwards straight to `fetch` |
| History replay | Full LLM transcript | Structured tool calls cannot survive a text-only replay |
