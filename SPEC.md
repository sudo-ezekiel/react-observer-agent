# react-observer-agent Technical Specification

> Version: 0.2.0
> Author: Ezekiel
> Status: Living document. Describes the library as implemented at v0.1.0, plus known divergences and roadmap.
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
 AgentResponse { message, toolCalls }   (readState calls excluded)
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
- Names beginning with `__` are **reserved** for internal tools (`__readState` today). The provider rejects user tools with reserved names. (Not yet enforced in v0.1.0; see section 7.)
- `handler` runs when the agent invokes the tool. Its return value is serialized and fed back to the LLM, so return something meaningful (`"Added Headphones to cart"`) rather than `undefined`.
- **LLM visibility rule:** a tool is only exposed to the model when it has a `description`. When `parameters` is omitted, the provider substitutes the empty object schema `{ "type": "object", "properties": {} }`. (v0.1.0 instead drops tools that lack either field; see section 7.)
- `parameters` is advisory in v0.1.0: it shapes what the LLM sends, and the library does **not** validate incoming arguments against it before calling `handler`. Handlers must treat `args` as untrusted input. Runtime validation is on the roadmap.
- `confirm: true` routes execution through the provider's `onConfirm` callback (section 4.4).

---

### 3.2 `<AIAgentProvider>`

React context provider that wires state, tools, model, and permissions together.

```tsx
type StateSource =
  | Record<string, unknown>            // Plain object, re-read on each access
  | (() => Record<string, unknown>);   // Getter, called on each access

interface AIAgentProviderProps {
  model: ModelAdapter;
  state: StateSource;
  tools: ToolDefinition[];
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

interface AgentContext {
  send: (message: string) => Promise<AgentResponse>; // Send a message to the agent
  isProcessing: boolean;                             // True while an interaction is in flight
  history: ConversationEntry[];                      // Session conversation history
  clearHistory: () => void;                          // Reset history and lastResponse
  lastResponse: AgentResponse | null;                // Most recent response (or error response)
}

interface AgentResponse {
  message: string;              // Agent's final text
  toolCalls: ToolCallResult[];  // User tools invoked during this interaction (all statuses)
  error?: AgentError;           // Present when the interaction failed
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
- On each `send()`, prior history is replayed to the LLM as plain `role` + `content` text. Structured tool calls from earlier interactions are not resent, so the model sees what was said, not the mechanics of how.
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

**Built-in and planned adapters**

| Adapter | Status | Notes |
|---------|--------|-------|
| `openAIAdapter` | Shipped (v0.1.0) | Chat completions with function calling; known bug, see section 7 |
| `claudeAdapter` | Planned | Anthropic Messages API with tool use |
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

The adapter requires either `apiKey` or `baseURL` and throws at initialization when given neither. When `baseURL` already contains `/chat/completions` it is used as-is; otherwise the path is appended.

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
   a. model.sendMessage({ messages, tools, systemPrompt, stateManifest })
   b. Text-only response: capture as final message, exit loop
   c. Tool calls: append the assistant message, then for each call:
      - __readState: filter requested keys to canAccess, snapshot state,
        append result as a tool message (internal, not surfaced)
      - name not in canExecute: append error result, status 'denied'
      - confirm:true: run onConfirm; on deny or missing handler,
        append cancelled result, status 'cancelled'
      - otherwise execute handler; append result,
        status 'success' | 'confirmed' | 'error'
   d. Next turn with the grown message list
6. Return AgentResponse { message, toolCalls }
```

When `maxTurns` is exhausted while the model is still calling tools, the loop stops and returns an **empty** `message` with whatever `toolCalls` accumulated (plus a debug warning). Surfacing this as a typed error (`code: 'MAX_TURNS'`) is on the roadmap.

Exceptions thrown anywhere in the loop (adapter failures included) are caught by the provider, converted to an `AgentResponse` with `error` set, stored in `lastResponse`, and passed to `onError`. `send()` resolves rather than rejects.

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
| `error` | Handler threw | `{ error }` |

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
    parameters: { type: 'object', properties: {} }, // explicit until v0.1.0 defaults this
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

// Types
export type {
  ToolDefinition, ToolOptions,
  AIAgentProviderProps, PermissionsConfig, AgentOptions,
  AgentContext, AgentResponse, ToolCallResult, ConversationEntry,
  ModelAdapter, ModelRequest, ModelResponse,
  StateSource, PendingToolCall, ToolCallEvent, AgentError,
  JSONSchema, LLMToolCall, LLMToolDefinition, ConversationMessage,
  OpenAIAdapterConfig,
} from './types';
```

`validateToolNames`, `filterState`, `filterTools`, and `validateToolCall` are exported as building blocks for testing and custom wiring; typical apps never call them directly.

---

## 7. Known divergences (spec vs. v0.1.0 code)

This spec is normative. Where the shipped code differs, the difference is listed here until fixed.

| # | Area | Spec says | v0.1.0 does | Severity |
|---|------|-----------|-------------|----------|
| 1 | Adapter serialization | Assistant messages carrying `toolCalls` must be serialized with the provider-native tool-call structure (section 3.4, rule 2) | `openAIAdapter` drops `toolCalls` when formatting assistant messages, so OpenAI rejects any request containing tool results with a 400. Since the pull refactor made every state read a tool round trip, this breaks most real interactions | Critical |
| 2 | Tool visibility | `description` required for LLM exposure; missing `parameters` defaults to an empty object schema | Tools missing either `description` or `parameters` are silently excluded from the LLM tool list, with no warning | High |
| 3 | Reserved names | Provider rejects user tools whose names start with `__` | No guard. A user tool named `__readState` is shadowed by the internal tool and its handler is unreachable | Low |
| 4 | Example app | State getters must be safe to call outside render (section 3.2) | `examples/basic` passes the Zustand hook itself (`state={useAppStore}`); resolving state calls the hook outside a component and throws | Medium (example only) |

---

## 8. Implementation status and roadmap

### Done (v0.1.0)

All eight phases of the original spec shipped: scaffolding (tsup, ESLint, Prettier, Vitest), tool registry, state observer, provider and `useAgent` hook, permission system, OpenAI adapter, agent execution loop, debug logging plus the Vite example app. The post-phase refactor replaced push-based state snapshots with the manifest + `__readState` pull model described in section 4.2.

### Next (v0.2 candidates, rough priority order)

1. Fix divergences 1 and 2 from section 7 (adapter serialization, tool visibility defaults).
2. `claudeAdapter` for the Anthropic Messages API.
3. Typed `maxTurns` exhaustion error (`AgentError.code: 'MAX_TURNS'`) instead of an empty message.
4. Runtime argument validation against `parameters` before invoking handlers.
5. Abort support: `send(message, { signal })` to cancel in-flight interactions.
6. Reserved-name validation (`__` prefix) at provider mount.
7. Structured history replay so prior tool calls survive across `send()` calls.
8. Streaming responses.
9. Surface `usage` totals per interaction for consumer-side cost tracking.

### Non-goals (for now)

- **DOM awareness / page context mapping**: deferred until the core is stable.
- **Automatic state detection**: too much magic; the explicit `state` prop is sufficient.
- **Multi-agent orchestration**: out of scope.
- **Persistent memory**: session memory only, no storage integration.
- **Token budget and cost tracking**: `maxTurns` bounds the loop; `usage` gives consumers the raw numbers.
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
