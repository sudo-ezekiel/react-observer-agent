# react-observer-agent Technical Specification

> Version: 0.3.0
> Author: Ezekiel
> Status: Living document. Describes the library as implemented at v0.3.0.
> Supersedes: 0.2.0 (July 28, 2026)
> Last updated: September 9, 2026

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
        |  (queued: one interaction at a time, in call order)
        v
 +-------------------- executeAgentLoop ---------------------+
 |                                                           |
 |  1. Build state manifest        (canAccess + descriptions)|
 |  2. Filter tools                (canExecute)              |
 |  3. Inject __readState tool     (if manifest non-empty)   |
 |  4. Turn loop (<= maxTurns):                              |
 |       model.sendMessage(...)  ----->  ModelAdapter        |
 |       <- text only?  break (TRUNCATED / REFUSED by stop)  |
 |       <- __readState?  validate, filter keys, feed back   |
 |       <- user tool?    validate -> confirm? -> execute    |
 |                        feed result back, next turn        |
 |     onEvent: turn_start, state_read, tool_start, tool_end |
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
4. **State size guard.** `options.maxStateBytes` caps the serialized size of each key a `__readState` call returns, so one oversized value cannot consume the context window on a single read (section 4.2).
5. **API keys stay off the client in production.** See the adapter security note in section 3.4.

---

## 3. Public API

### 3.1 `registerTool(name, handler, options?)`

Creates a validated tool definition the agent is allowed to invoke.

```ts
interface ToolContext {
  signal?: AbortSignal; // Aborts when the interaction is cancelled
}

type ToolHandler<TArgs = unknown> = (
  args: TArgs,
  context?: ToolContext,
) => unknown | Promise<unknown>;

// With a Standard Schema, the argument type comes from the schema output.
function registerTool<S extends StandardSchemaV1>(
  name: string,
  handler: ToolHandler<InferSchemaOutput<S>>,
  options: ToolOptions & { schema: S },
): ToolDefinition<InferSchemaOutput<S>>;
// Without one, the argument type is the handler's own.
function registerTool<TArgs = unknown>(
  name: string,
  handler: ToolHandler<TArgs>,
  options?: ToolOptions,
): ToolDefinition<TArgs>;

interface ToolOptions {
  description?: string;      // Shown to the LLM; required for the tool to be visible to it
  parameters?: JSONSchema;   // JSON Schema for the arguments; defaults to an empty object schema
  schema?: StandardSchemaV1; // Optional Standard Schema validator; replaces the built-in check
  confirm?: boolean;         // Require user confirmation before execution (default: false)
}

interface ToolDefinition<TArgs = unknown> {
  name: string;
  handler: ToolHandler<TArgs>;
  description?: string;
  parameters?: JSONSchema;
  schema?: StandardSchemaV1;
  confirm: boolean;
}
```

The package ships a minimal copy of the [Standard Schema v1](https://standardschema.dev) interface (`StandardSchemaV1`, `StandardSchemaProps`, `StandardSchemaResult`, `StandardSchemaIssue`, `InferSchemaOutput`). The spec is designed to be copied, so accepting Zod 3.24+, Valibot 1+, and ArkType 2+ validators costs no dependency.

**Behavior**

- `name` must be unique across all tools passed to a single provider. Uniqueness is enforced at the provider level, not at registration time, so tools can be composed from independent modules without global coordination. The provider throws on mount when it detects duplicates.
- Names beginning with `__` are **reserved** for internal tools (`__readState` today). The provider rejects user tools with reserved names on mount.
- `handler` runs when the agent invokes the tool as `handler(args, { signal })`. The loop always passes the context; the parameter is typed optional so handlers written against 0.2.0, which take one argument, keep their type. `signal` is the one given to `send()`, so a handler that forwards it to `fetch` stops when the interaction is cancelled. Its return value is serialized and fed back to the LLM, so return something meaningful (`"Added Headphones to cart"`) rather than `undefined`. A result `JSON.stringify` cannot serialize is a handler error, not a success.
- **LLM visibility rule:** a tool is only exposed to the model when it has a `description`. When `parameters` is omitted, the provider substitutes the empty object schema `{ "type": "object", "properties": {} }`. A tool hidden for lacking a description is still executable if the model names it, since `canExecute` is the authority.
- **Validation.** Arguments are validated before the handler runs, and before the confirmation prompt (section 4.4). With `schema` set, validation runs through `schema['~standard'].validate` (sync or async) and the handler, the confirmation prompt, and every report receive the value the schema returned, so defaults and transforms apply. Issues are formatted as `path: message`. Without `schema`, `parameters` is checked by the built-in validator, which covers a subset of JSON Schema (`type`, `properties`, `required`, `items`, `enum`) and ignores keywords outside it, so a richer schema validates on the parts the library understands rather than failing outright. Handlers using only `parameters` should still treat `args` as untrusted, since unvalidated keywords pass through.
- **`parameters` and `schema` are independent.** `parameters` is what the model sees; `schema` is what the arguments are checked against. The library does not derive one from the other, so a tool with a `schema` should still carry `parameters` (or accept the empty object schema and let the model guess).
- **Typing.** With `schema`, an un-annotated handler infers its argument type from the schema output, and an annotated handler must match it: an annotation that disagrees with the schema output is a compile error rather than a silent fall-through to the untyped overload. Without `schema`, the explicit generic (`registerTool<{ path: string }>(...)`), a pre-typed `ToolOptions` variable, no options at all, and one-argument handlers all compile as before.
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
  maxStateBytes?: number;                     // Per-key byte ceiling on __readState results (default: none)
  onError?: (error: AgentError) => void;      // Called when send() fails (except ABORTED)
  onToolCall?: (call: ToolCallEvent) => void; // Observer for user-tool outcomes
  onConfirm?: (call: PendingToolCall) => Promise<boolean>; // Approval handler for confirm:true tools
  onEvent?: (event: AgentEvent) => void;      // Observer for loop progress (section 4.7)
}

interface PendingToolCall {
  toolName: string;
  args: unknown;        // The validated value
  description?: string;
  signal?: AbortSignal; // Aborts if the interaction is cancelled while confirmation is pending
}

type ToolCallStatus = 'success' | 'error' | 'denied' | 'confirmed' | 'cancelled';

interface ToolCallEvent {
  toolName: string;
  args: unknown;
  result: unknown;
  status: ToolCallStatus;
}

type AgentEvent =
  | { type: 'turn_start'; turn: number; maxTurns: number }
  | { type: 'state_read'; requested: string[]; keys: string[] }
  | { type: 'tool_start'; toolName: string; args: unknown }
  | { type: 'tool_end'; toolName: string; args: unknown; result: unknown; status: ToolCallStatus };
```

**Behavior**

- `state` accepts either form:
  - **Object**: read directly each time state is resolved. Works naturally with React state (`state={{ user, cart }}`), since re-renders pass a fresh object.
  - **Getter function**: called each time state is resolved. Works with external stores: `() => useStore.getState()` for Zustand, `() => store.getState()` for Redux.
  - The getter runs **outside React rendering** (inside the async agent loop), so it must not call hooks. Pass `() => useStore.getState()`, never the hook itself (`state={useStore}` throws an invalid hook call when the agent reads state).
- `permissions.canAccess` defines the manifest: only listed keys are advertised to the LLM, and `__readState` requests are filtered to this list.
- `permissions.stateDescriptions` optionally attaches a human-readable description to each manifest key. Missing entries fall back to the key name. Good descriptions let the model pick the right key without reading everything.
- `permissions.canExecute` filters the tool list. A registered tool absent from `canExecute` is never shown to the LLM.
- `options.maxStateBytes` applies per key: a value whose JSON exceeds it is replaced by a truncation marker (section 4.2). Unset means no limit.
- `options.onEvent` observes the loop (section 4.7). `options.onToolCall` fires once per user-tool outcome with the same payload as `tool_end`. Both are observation only; a callback that throws ends the interaction with an untyped error, so keep them cheap and safe.
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
  isProcessing: boolean;                             // True while any send() is pending or running
  history: ConversationEntry[];                      // Session conversation history
  clearHistory: () => void;                          // Reset history, transcript, and lastResponse
  lastResponse: AgentResponse | null;                // Most recent response (or error response)
}

interface AgentResponse {
  message: string;              // Agent's final text
  toolCalls: ToolCallResult[];  // User tools invoked during this interaction (all statuses)
  error?: AgentError;           // Present when the interaction failed or was cancelled
  usage?: TokenUsage;           // Totalled across turns, when the adapter reports it
}

interface ToolCallResult {
  toolName: string;
  args: unknown;                // The validated value, or the raw arguments when validation did not run or failed
  result: unknown;
  status: ToolCallStatus;
}

interface ConversationEntry {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[];
  error?: AgentError;           // Assistant entries only: the interaction ended with this error, ABORTED included
  timestamp: number;
}

type AgentErrorCode = 'ABORTED' | 'MAX_TURNS' | 'ADAPTER_ERROR' | 'TRUNCATED' | 'REFUSED';

interface AgentError {
  message: string;
  code?: AgentErrorCode;        // Absent when an exception other than AdapterError was thrown
  status?: number;              // HTTP status when the failure came from an adapter with one
  cause?: unknown;
}

interface TokenUsage {
  promptTokens: number;         // Total input tokens, cached portion included
  completionTokens: number;     // Output tokens
  cacheReadTokens?: number;     // Part of promptTokens served from the cache, when reported
  cacheWriteTokens?: number;    // Part of promptTokens written to the cache, when reported
}
```

**Send semantics**

- `send()` calls are **queued**. Each call chains onto the previous one, so interactions run strictly one at a time in call order and each starts from the transcript the previous one left. A queued call whose signal is already aborted when its turn comes returns `ABORTED` without calling the model. One failed interaction does not stall the ones queued behind it.
- `isProcessing` is true from the moment a `send()` is called until the last queued call settles, with no false flicker between queued calls.
- `send()` resolves rather than rejects. Every failure, including thrown exceptions, comes back as `AgentResponse.error`.

**Error codes**

| Code | Set by | `message` | Reaches `onError` |
|------|--------|-----------|-------------------|
| `ABORTED` | The signal fired (checked per turn, after the model call, before each tool, after validation, after confirmation) | Empty | No |
| `MAX_TURNS` | `maxTurns` exhausted while the model was still calling tools | Empty | Yes |
| `ADAPTER_ERROR` | The adapter threw an `AdapterError`; `status` copied from it | Empty | Yes |
| `TRUNCATED` | The model stopped with `stopReason: 'max_tokens'` and no tool calls | The partial text | Yes |
| `REFUSED` | The model stopped with `stopReason: 'refusal'` and no tool calls | Whatever text came back | Yes |
| (none) | Any other exception: a throwing callback, state getter, or custom adapter throwing a plain `Error` | Empty | Yes |

Cumulative `toolCalls` and `usage` are kept on every error response the loop produced itself. The thrown-exception path has neither.

**History semantics**

- Every interaction that started produces exactly one `user` entry and one `assistant` entry, in that order. The user entry is appended when the queued call begins executing, not when `send()` was called, so `history` always alternates user, assistant. Tool activity rides on the assistant entry's `toolCalls`; standalone `tool` entries are reserved for future use.
- An assistant entry whose interaction ended with an error carries it on `error`. This includes `ABORTED` and the thrown-exception path, where `content` is `''` and `toolCalls` is `[]`.
- History is scoped to the provider instance. Unmount clears it; `clearHistory()` clears it manually.
- On each `send()`, the prior LLM-facing transcript is replayed verbatim, including assistant tool calls and the tool results answering them, so the agent can reason about what it already did. The provider keeps this transcript separately from the user-facing `history`.
- An aborted turn is **not** added to the transcript. A cancel can land between an assistant tool call and the result answering it, and providers reject that shape. A turn whose adapter threw is likewise dropped. A final assistant message with empty content is not persisted either.
- `clearHistory()` during an in-flight interaction discards that interaction: when it finishes, it writes nothing to `history`, `lastResponse`, or the transcript. Its `send()` still resolves with the response and `onError` still fires under the usual rules. The user entry it appended at start went with the clear.
- Replayed `__readState` results hold the values read at the time. The manifest instruction tells the model to re-read when it needs current values; `clearHistory()` drops the transcript entirely.
- `__readState` activity never appears in `history`, `AgentResponse.toolCalls`, or `onToolCall` (section 4.2). The `state_read` event is the one place it is observable.

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
  isError?: boolean;           // Tool messages only: the result reports a failure
  providerData?: unknown;      // Opaque, adapter-owned; copied from ModelResponse and replayed verbatim
}

type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

interface ModelResponse {
  content: string | null;      // Text response (null when the model only called tools)
  toolCalls?: LLMToolCall[];   // Requested tool invocations
  usage?: TokenUsage;
  stopReason?: StopReason;     // Why the model stopped, normalized
  providerData?: unknown;      // Anything the adapter needs back unchanged on replay
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

class AdapterError extends Error {
  readonly name: 'AdapterError';
  readonly status?: number;    // HTTP status, when the failure came from a response
  readonly body?: string;      // Raw response text, when there was one
  constructor(message: string, options?: { status?: number; body?: string; cause?: unknown });
}
```

**Adapter contract**

An adapter MUST:

1. Map all three message roles to the provider's native format, preserving order.
2. Serialize `toolCalls` on assistant messages into the provider's native structure (OpenAI: `tool_calls`; Anthropic: `tool_use` blocks). Providers reject tool-result messages that do not follow an assistant message carrying the matching call, so dropping this field breaks every tool round trip.
3. Link tool messages to their originating call via `toolCallId` (OpenAI: `tool_call_id`; Anthropic: `tool_use_id`).
4. Parse tool-call arguments from the wire format into `LLMToolCall.arguments` (JSON-parse with a raw-string fallback for malformed JSON).
5. Throw on network failures, non-2xx responses, and malformed payloads. Throwing an `AdapterError` gets the failure surfaced as `error.code: 'ADAPTER_ERROR'` with `status`; a plain `Error` surfaces without a code. Either way the provider converts the throw into `AgentResponse.error` and invokes `onError`.
6. Treat `state` as dead weight (always `{}`) and `stateManifest` as optional context; the manifest is already injected into `systemPrompt` by the loop.
7. Forward `signal` to the transport, and rethrow an `AbortError` unchanged rather than rewrapping it as a transport failure. The loop identifies cancellation by that error name.
8. Skip assistant messages whose `content` is empty and which carry no `toolCalls`. Both providers reject an empty assistant turn, and the loop keeps the final one out of the transcript already; this covers transcripts from older versions or custom sources.

An adapter SHOULD:

9. Report `stopReason`. The loop maps `max_tokens` to `TRUNCATED` and `refusal` to `REFUSED` when the response carries no tool calls; a missing `stopReason` is treated as a normal end. Tool calls in a response are processed regardless of stop reason.
10. Report `usage` with `promptTokens` as the **total** input for the call, cached tokens included, and break the cached part out into `cacheReadTokens` and `cacheWriteTokens` when the provider reports it. The loop sums each field across turns and omits the cache fields from the total when they were never above zero.
11. Set `providerData` on `ModelResponse` when the provider needs something back unchanged (Anthropic's thinking blocks and signatures, for example), and honor it on replay: when an assistant message carries `providerData`, use it in preference to rebuilding the message from `content` and `toolCalls`.
12. Map `isError` on tool messages to the provider's failure flag when it has one (Anthropic: `is_error` on `tool_result`). OpenAI has none, so the adapter ignores it.

The loop passes a snapshot of `messages`, so an adapter may hold onto it across awaits without observing later turns.

**Built-in adapters**

| Adapter | Status | Notes |
|---------|--------|-------|
| `openAIAdapter` | Shipped | Chat completions with function calling; also covers OpenAI-compatible endpoints such as Ollama (below) |
| `claudeAdapter` | Shipped (v0.2.0) | Anthropic Messages API with tool use, prompt caching, and thinking block replay |
| Custom | Supported | Implement `ModelAdapter` and pass it to the provider |

```ts
function openAIAdapter(config: OpenAIAdapterConfig): ModelAdapter;

interface OpenAIAdapterConfig {
  apiKey?: string;            // Dev and prototyping only; see security note
  model?: string;             // Default: 'gpt-4o'
  baseURL?: string;           // Proxy endpoint (recommended for production)
  temperature?: number | null; // Default: 0.2; null omits the field entirely
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
  cache?: boolean;          // Prompt caching for tools and system prompt; default: true
  headers?: Record<string, string>; // Extra headers, spread last so they win
}
```

Both adapters require either `apiKey` or `baseURL` and throw at initialization when given neither. When `baseURL` already contains the endpoint path (`/chat/completions` for OpenAI, `/v1/messages` for Claude) it is used as-is; otherwise the path is appended.

Both throw `AdapterError`: with `status` and `body` for a non-2xx response, without `status` for a network failure or an unparseable body. An `AbortError` from `fetch` propagates untouched.

`openAIAdapter` details:

- `temperature: null` omits the field, for reasoning models that reject any value other than their own default. `undefined` sends the default `0.2`.
- `finish_reason` maps to `stopReason`: `stop` to `end`, `tool_calls` and `function_call` to `tool_use`, `length` to `max_tokens`, `content_filter` to `refusal`, anything else to `other`.
- `usage.prompt_tokens_details.cached_tokens` maps to `cacheReadTokens`. OpenAI counts cached tokens inside `prompt_tokens`, so `promptTokens` is already the total.

`claudeAdapter` details:

- Sends `anthropic-version: 2023-06-01` and, when `apiKey` is set, `x-api-key`. It sends no sampling parameters, which current Claude models reject.
- **Prompt caching.** With `cache` unset or `true` and a system prompt present, `system` is sent as a one-element array of text blocks whose block carries `cache_control: { type: 'ephemeral' }`. Tools and the system prompt render before the messages, so one breakpoint caches both. With `cache: false`, or no system prompt, `system` is a plain string or omitted.
- **Provider data.** `parseResponse` sets `providerData` to the raw `content` block array. On replay, an assistant message carrying a non-empty `providerData` array is sent with exactly those blocks; otherwise text and `tool_use` blocks are rebuilt from `content` and `toolCalls`. This is what keeps thinking blocks and their signatures intact, which Anthropic requires.
- `stop_reason` maps to `stopReason`: `end_turn` to `end`, `tool_use`, `max_tokens`, and `refusal` to themselves, anything else (including `stop_sequence`, `pause_turn`, and a missing value) to `other`.
- **Usage.** Anthropic reports cached tokens outside `input_tokens`, so `promptTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The two cache fields map to `cacheReadTokens` and `cacheWriteTokens` when present.
- `isError` on a tool message becomes `is_error: true` on the `tool_result` block.
- Calling the Anthropic API directly from a browser additionally requires that provider's CORS opt-in header; pass it through `headers` (the proxy pattern below avoids the question entirely, and is the recommended production path regardless).

**Ollama recipe (untested).** Ollama serves an OpenAI-compatible chat completions endpoint, so a local model needs no dedicated adapter:

```ts
const model = openAIAdapter({
  baseURL: 'http://localhost:11434/v1',
  model: 'llama3.1', // any model whose Ollama page lists tool support
});
```

The model must support tool calling, since state reads and every action go through tools. The author has not exercised this recipe; it follows from the endpoint contract rather than from a test run.

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

`send(message)` runs the following (implemented in `src/provider/executeAgentLoop.ts`, one interaction at a time per provider):

```
1. Build state manifest from canAccess + stateDescriptions
2. Filter tools by canExecute; map to LLM tool definitions
3. Append __readState to the tool list when the manifest is non-empty
4. System prompt = options.systemPrompt + generated manifest prompt
5. Turn loop, at most maxTurns iterations (default 5):
   a. If the signal is aborted, stop and return an ABORTED error
   b. Emit turn_start, then
      model.sendMessage({ messages, tools, systemPrompt, stateManifest, signal })
      An AbortError from the adapter also ends the loop as ABORTED
   c. Accumulate reported token usage
   d. No tool calls: this is the answer. stopReason max_tokens marks it
      TRUNCATED, refusal marks it REFUSED; either way the loop exits
   e. Tool calls: append the assistant message (with providerData), then
      for each call:
      - stop first if the signal is aborted, before any further side effect
      - __readState: validate the arguments against its schema (invalid ones
        get an isError tool message and nothing else), filter requested
        keys to canAccess, snapshot state under maxStateBytes, emit
        state_read, append the result as a tool message (internal)
      - emit tool_start with the raw arguments
      - name not in canExecute, or no definition for it: append an isError
        result, record status 'denied'
      - arguments failing validation: append the isError validation error,
        record status 'error'; the handler does not run
      - abort landed during validation: record 'cancelled', return ABORTED
      - confirm:true: run onConfirm with the validated value and the signal
        (section 4.4); on deny or missing handler, record 'cancelled'
      - execute handler(value, { signal }); serialize the result; record
        'success' | 'confirmed' | 'error'; a rejection with AbortError after
        the signal fired records 'cancelled' and returns ABORTED
      - recording = one toolCalls entry, one onToolCall, one tool_end
   f. Next turn with the grown message list
6. Append the final assistant message when its content is non-empty
7. Return the response plus the message list, for replay on the next send
```

When `maxTurns` is exhausted while the model is still calling tools, the loop returns an empty `message`, whatever `toolCalls` accumulated, and `error.code: 'MAX_TURNS'` (plus a debug warning). A cancelled interaction returns `error.code: 'ABORTED'` the same way. A truncated or refused answer returns the text that came back with `TRUNCATED` or `REFUSED`. None of these throw.

Exceptions thrown anywhere in the loop (adapter failures, throwing callbacks, a throwing state getter) are caught by the provider, converted to an `AgentResponse` with `error` set (`ADAPTER_ERROR` with `status` for an `AdapterError`, no code otherwise), stored in `lastResponse`, and passed to `onError`. `send()` resolves rather than rejects. Errors the loop returns rather than throws also reach `onError`, with one exception: `ABORTED` does not, since a cancel is a caller decision rather than an application failure.

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

4. **Argument validation.** The call is validated against that schema before anything else. A malformed call (`keys` as a string, for example) gets a tool message `{ error: 'Invalid arguments for __readState: ...' }` flagged `isError`, a debug warning, and nothing more: no `toolCalls` entry, no `onToolCall`, no event.
5. **Enforcement on read.** Requested keys are intersected with `canAccess`; unauthorized keys are silently dropped. The state source is resolved at call time (`typeof state === 'function' ? state() : state`), filtered to the allowed keys, and serialized.
6. **Serialization safety.** Functions, symbols, bigints, and values that fail `JSON.stringify` (circular references) are stripped, with a warning in debug mode.
7. **Size guard.** With `maxStateBytes` set, a key whose JSON is longer than the limit is replaced by `{ __truncated: true, limit, bytes, preview }`, where `bytes` is the actual length and `preview` the first `limit` characters of the JSON, with a debug warning. The limit is per key, not per read.
8. **Observation.** A valid read emits `state_read` with `requested` (as sent by the model) and `keys` (the allowed subset that was read).
9. **Invisibility.** `__readState` never appears in `AgentResponse.toolCalls`, `onToolCall`, or `history`. It exists only inside the LLM-facing message list so the model can reason across turns.

Rationale, trade-offs, and a worked example live in [docs/internals.md](docs/internals.md).

### 4.3 Permission enforcement

Permissions are enforced at two layers:

1. **Visibility (before the LLM call).** The model only ever sees manifest keys from `canAccess` and tools from `canExecute`. The agent cannot request what it cannot see.
2. **Execution (after the LLM response).** Tool names are re-validated against `canExecute` before execution, and `__readState` requests are re-filtered against `canAccess`. A hallucinated or injected name is rejected with status `'denied'`.

### 4.4 Confirmation flow

Argument validation runs first, so a malformed call is rejected before anyone is asked to approve it, and the value passed to `onConfirm` is the validated one.

For a tool registered with `confirm: true`:

- With an `onConfirm` handler: the loop awaits `onConfirm({ toolName, args, description, signal })`. Resolving `true` executes the handler (final status `'confirmed'`); resolving `false` skips it (status `'cancelled'`, the LLM is told the user denied it).
- Without a handler: the tool is skipped with status `'cancelled'` and a debug warning. Confirmation is never silently bypassed.

Confirmation can take arbitrarily long, so it interacts with cancellation:

- If the signal is aborted by the time `onConfirm` resolves, the answer is stale whatever it was. The handler does not run, the call is recorded as `'cancelled'` with result `'Tool execution cancelled: interaction aborted'`, and the interaction ends `ABORTED`.
- If `onConfirm` rejects with an `AbortError`, or rejects after the signal fired, the same cancellation applies. A confirmation UI that unmounts on cancel typically rejects rather than answers, and that is a cancel, not a tool failure.
- Any other rejection is a tool error: the call is recorded with status `'error'` and the rejection message, the LLM receives `{ error }` flagged `isError`, and the loop continues with the next call.

The consumer owns the UI: modal, toast, inline card, `window.confirm`, anything that eventually yields a boolean. `signal` is there so the UI can close itself when the interaction is cancelled underneath it.

### 4.5 Tool call statuses

| Status | Meaning | Fed back to LLM as | `isError` |
|--------|---------|--------------------|-----------|
| `success` | Tool executed normally (no confirmation required) | `{ result }` | no |
| `confirmed` | `confirm: true` tool approved and executed | `{ result }` | no |
| `cancelled` | `confirm: true` tool denied, no `onConfirm` handler, or the interaction was aborted during validation, confirmation, or the handler | `{ status: 'cancelled', reason }` | no |
| `denied` | Name failed the `canExecute` check, or passed it with no matching definition | `{ error }` | yes |
| `error` | Handler threw, result not serializable, arguments failed validation, or `onConfirm` rejected with something other than an `AbortError` | `{ error }` | yes |

Every outcome above produces exactly one `toolCalls` entry, one `onToolCall`, and one `tool_end`. `args` on all three is the validated value once validation succeeded, and the raw model arguments on the `denied` and invalid-arguments paths where no validated value exists. Neither fires for `__readState`.

### 4.6 Debug logging

With `options.debug: true`, the loop logs manifest keys, the exposed tool list, per-turn request and response summaries, `__readState` requested vs. allowed keys with results, invalid `__readState` arguments, truncated state keys, and tool execution outcomes, all prefixed `[react-observer-agent]`. Full detail in [docs/internals.md](docs/internals.md).

### 4.7 Events

`options.onEvent` receives an `AgentEvent` at these points, in this order within an interaction:

| Event | Fired | Payload |
|-------|-------|---------|
| `turn_start` | Right before each `model.sendMessage` | `turn` (1-based), `maxTurns` |
| `state_read` | After a valid `__readState` call resolved | `requested`, `keys` |
| `tool_start` | For every user tool the model requested, before the permission check | `toolName`, `args` (raw, as the model sent them) |
| `tool_end` | Once per `tool_start`, when the outcome is known | `toolName`, `args` (validated when validation ran), `result`, `status` |

Guarantees: every `tool_start` has exactly one `tool_end`, `tool_end` fires at the same moment as `onToolCall` with the same payload, and an interaction that aborts mid-call still closes the open `tool_start` with a `cancelled` `tool_end` before returning. Events are observation only and carry no way to alter the run.

---

## 5. Usage

### 5.1 Installation

```bash
npm install react-observer-agent
```

The published bundle begins with a `'use client'` directive, so it imports cleanly from a Next.js App Router component tree.

### 5.2 Register tools

```ts
// tools.ts
import { registerTool } from 'react-observer-agent';
import { z } from 'zod';
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

  // A Standard Schema types the handler and validates at runtime. `parameters`
  // is still what the model sees.
  registerTool('addToCart', (args) => {
    useStore.getState().addToCart(args.productId, args.qty);
    return `Added ${args.qty} x ${args.productId} to cart`;
  }, {
    description: 'Add a product to the shopping cart',
    parameters: {
      type: 'object',
      properties: { productId: { type: 'string' }, qty: { type: 'integer' } },
      required: ['productId'],
    },
    schema: z.object({ productId: z.string(), qty: z.number().int().positive().default(1) }),
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

  // Long-running work should forward the interaction signal.
  registerTool('searchProducts', async (args: { query: string }, context) => {
    const res = await fetch(`/api/search?q=${encodeURIComponent(args.query)}`, {
      signal: context?.signal,
    });
    return res.json();
  }, {
    description: 'Search the product catalog',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
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
        canExecute: ['navigateTo', 'addToCart', 'clearCart', 'searchProducts'],
        stateDescriptions: {
          user: 'Current logged-in user profile',
          cart: 'Shopping cart items and quantities',
          products: 'Available product catalog with IDs, names, and prices',
        },
      }}
      options={{
        debug: true,
        maxTurns: 5,
        maxStateBytes: 20_000,
        onConfirm: async (call) =>
          window.confirm(`Allow agent to run "${call.toolName}"?`),
        onEvent: (event) => {
          if (event.type === 'tool_start') showSpinner(event.toolName);
          if (event.type === 'tool_end') hideSpinner(event.toolName);
        },
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
        <div key={i} className={entry.role}>
          {entry.content}
          {entry.error && <span className="error">{entry.error.message}</span>}
        </div>
      ))}
      {isProcessing && <Spinner />}
      <input value={input} onChange={(e) => setInput(e.target.value)} />
      <button onClick={handleSend} disabled={isProcessing}>Send</button>
    </div>
  );
}
```

Disabling the button is a UI choice, not a requirement: a second `send()` while one is running queues behind it.

### 5.5 What happens under the hood

**User asks: "What's in my cart?"**

1. The loop advertises the manifest (`user`, `cart`, `products` with descriptions) and the `__readState` tool.
2. The LLM calls `__readState({ keys: ["cart"] })`.
3. The loop verifies `cart` is in `canAccess`, resolves the state source, and returns `{ "cart": [...] }` as the tool result. `onEvent` sees `state_read`.
4. The LLM answers: "You have 2 items in your cart: ...". The readState round trip is invisible to the consumer.

**User asks: "Add the blue sneakers to my cart"**

1. The LLM may first call `__readState({ keys: ["products"] })` to find the ID.
2. It then calls `addToCart({ productId: "blue-sneakers-123" })`. The Zod schema fills in `qty: 1`.
3. `confirm: true` routes through `onConfirm` with the validated value; on approval the handler runs and the result is fed back (status `'confirmed'`).
4. The LLM closes with: "Done! Blue sneakers added to your cart."
5. On denial, the tool is skipped with status `'cancelled'` and the LLM is told the user declined.

---

## 6. Package exports

Mirrors `src/index.ts`:

```ts
// Functions and components
export { registerTool } from './tools/registerTool';
export { validateToolNames } from './tools/validateToolNames';
export { validateToolArgs } from './tools/validateToolArgs';
export { AIAgentProvider } from './provider/AIAgentProvider';
export { useAgent } from './provider/useAgent';
export { filterState } from './permissions/filterState';
export { filterTools } from './permissions/filterTools';
export { validateToolCall } from './permissions/validateToolCall';
export { openAIAdapter } from './adapters/openai';
export { claudeAdapter } from './adapters/claude';
export { AdapterError } from './adapters/AdapterError';

// Types
export type {
  ToolDefinition, AnyToolDefinition, ToolOptions, ToolContext, ToolHandler,
  StandardSchemaV1, StandardSchemaProps, StandardSchemaResult, StandardSchemaIssue, InferSchemaOutput,
  AIAgentProviderProps, PermissionsConfig, AgentOptions,
  AgentContext, AgentResponse, AgentEvent, AgentErrorCode,
  ToolCallResult, ToolCallStatus, TokenUsage, ConversationEntry,
  ModelAdapter, ModelRequest, ModelResponse, StopReason,
  StateSource, PendingToolCall, ToolCallEvent, SendOptions, AgentError,
  JSONSchema, LLMToolCall, LLMToolDefinition, ConversationMessage,
  OpenAIAdapterConfig, ClaudeAdapterConfig,
} from './types';
export type { ToolArgsValidation } from './tools/validateToolArgs';
```

`validateToolNames`, `validateToolArgs`, `filterState`, `filterTools`, and `validateToolCall` are exported as building blocks for testing and custom wiring; typical apps never call them directly.

The build emits ESM and CJS with matching `.d.ts` and `.d.cts` files, and both bundles start with a `'use client'` directive. `publint` and `@arethetypeswrong/cli` run in CI against the packed tarball.

---

## 7. Known divergences (spec vs. code)

None. Everything in sections 3 and 4 matches `src/` at v0.3.0. This section stays as the place to record future gaps between this spec and shipped behavior.

---

## 8. Implementation status and roadmap

### Done (v0.3.0)

Everything in sections 3 and 4 is implemented and covered by tests on React 18 and 19: the tool registry with reserved-prefix and uniqueness validation, Standard Schema and built-in argument validation, tool handler context, pull-based state via the manifest and `__readState` with the size guard, the two-layer permission model, the confirmation flow with abort handling, the interaction queue, the event stream, typed error codes and `AdapterError`, stop reasons, structured conversation replay with provider data, usage aggregation with cache fields, and both the OpenAI and Claude adapters.

### Next (rough priority order)

1. Streaming responses, which need a `ModelAdapter` extension and an incremental `useAgent` surface.
2. Transcript compaction, so long sessions stay under the model's context window instead of growing unbounded until `clearHistory()`.
3. Per-tool permission scoping beyond the flat `canExecute` list.

Two former candidates are off the list. Deeper built-in JSON Schema validation is covered by the `schema` option: anyone who needs `additionalProperties`, numeric bounds, or `$ref` can bring a real validator without the package taking on the dependency. A dedicated `ollamaAdapter` is unnecessary because Ollama serves an OpenAI-compatible endpoint (section 3.4).

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
| Build | tsup | Fast, zero-config, dual CJS/ESM; `'use client'` banner for App Router consumers |
| Test | Vitest + React Testing Library | Fast, ESM-native, good React support; CI matrix over React 18 and 19 |
| Lint | ESLint + Prettier | Standard tooling; format check gates CI |
| Package checks | publint + arethetypeswrong | Catches exports-map and types resolution mistakes before publish |
| React version | >=18 (peer dep) | Hooks, concurrent features |
| State access | Pull-based via `__readState` | Token cost scales with what the agent reads, not with app state size; unread state never leaves the client |
| State source | Object or getter prop | Object for React state; getter for external stores |
| State size guard | Per-key byte ceiling with a preview marker | One oversized key cannot spend the context window; the model still learns what was there |
| Permissions | Whitelist-only | Deny unless explicitly allowed |
| LLM communication | Adapter pattern | Decouples the core from any specific provider |
| Reserved tool namespace | `__` prefix | Internal tools can be added without colliding with user tools |
| Argument validation | Hand-written JSON Schema subset, or a Standard Schema via `schema` | Dependency free by default; the Standard Schema interface is meant to be copied, so real validators plug in without one |
| Cancellation | `AbortSignal` on `send()`, forwarded to adapter, `onConfirm`, and handlers | Standard platform primitive, forwards straight to `fetch` |
| Concurrency | `send()` queue with a generation guard | Overlapping interactions would fork the transcript and interleave history; a queue keeps one truth per provider |
| History replay | Full LLM transcript | Structured tool calls cannot survive a text-only replay |
| Provider data | Opaque `providerData` copied to assistant messages and replayed verbatim | Anthropic requires thinking blocks back unchanged; the loop never needs to understand them |
| Error reporting | `AdapterError` with `status`, typed `AgentErrorCode` | A 401 and a 429 are different problems; callers should not parse messages to tell them apart |
| Events | `onEvent` observation stream | Progress UI without exposing loop internals or a way to alter the run |
