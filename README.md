![ShowCase](https://github.com/user-attachments/assets/84c38dc6-7f62-4c37-8d96-3b3eac489140)

# react-observer-agent

A React library that lets an LLM agent observe your app's state, understand what the user is doing, and execute pre-defined actions, all through a declarative `<AIAgentProvider>` and registered tools, with permission boundaries built in.

Docs and live examples: **[reactobserveragent.sudo-ezekiel.com](https://reactobserveragent.sudo-ezekiel.com)**

This is an experimental project by a solo developer. I am exploring whether an AI agent can be useful inside a live React app without dumping your whole state into a prompt or letting the model run arbitrary code. It works and it is tested, but it remains a research project rather than a product. See the [disclaimer](#disclaimer).

- Zero runtime dependencies (adapters use raw `fetch`, no SDKs)
- TypeScript, dual ESM/CJS builds with types included
- React >= 18 (peer dependency); CI runs the suite against React 18 and 19
- Works with any state manager: Zustand, Redux, vanilla React state

## Install

```bash
npm install react-observer-agent
```

The bundle starts with a `'use client'` directive, so importing it from a Next.js App Router component needs no wrapper file.

## Quick start

```tsx
import { AIAgentProvider, registerTool, openAIAdapter, useAgent } from 'react-observer-agent';
import { useStore } from './store';

// 1. Register tools: actions the agent is allowed to perform.
//    A handler receives (args, context); context?.signal aborts when the
//    interaction is cancelled, so forward it to anything long-running.
const tools = [
  registerTool('goToPage', (args: { path: string }) => navigate(args.path), {
    description: 'Navigate to a page in the app',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }),
  registerTool(
    'searchProducts',
    async (args: { query: string }, context) => {
      const res = await fetch(`/api/search?q=${encodeURIComponent(args.query)}`, {
        signal: context?.signal,
      });
      return res.json();
    },
    {
      description: 'Search the product catalog',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  ),
  registerTool('submitForm', () => handleSubmit(), {
    description: 'Submit the current form',
    confirm: true, // requires user approval before executing
  }),
];

// 2. Configure the model adapter (route through your backend in production)
const model = openAIAdapter({
  baseURL: '/api/agent', // your backend proxy holds the real API key
});
// Or Claude, same interface: claudeAdapter({ baseURL: '/api/agent' })

// 3. Wrap your app with the provider
export default function App() {
  return (
    <AIAgentProvider
      model={model}
      state={() => {
        const { user, cart } = useStore.getState();
        return { user, cart };
      }}
      tools={tools}
      permissions={{
        canAccess: ['user', 'cart'],
        canExecute: ['goToPage', 'searchProducts', 'submitForm'],
        stateDescriptions: {
          user: 'Current logged-in user profile',
          cart: 'Shopping cart items and quantities',
        },
      }}
      options={{
        onConfirm: async (call) => window.confirm(`Allow "${call.toolName}"?`),
      }}
    >
      <YourApp />
    </AIAgentProvider>
  );
}

// 4. Interact with the agent from any component
function ChatPanel() {
  const { send, isProcessing, history } = useAgent();
  // send("What's in my cart?") -> agent reads state, responds with text
  // send("Go to settings")     -> agent calls goToPage({ path: '/settings' })
  // send(text, { signal })     -> pass an AbortSignal to cancel mid-flight
  // Two sends in a row queue up and run one at a time, in call order.
}
```

The `state` prop takes either a plain object or a getter function:

```tsx
// Vanilla React state: pass an object, re-renders keep it fresh
<AIAgentProvider state={{ user, cart }} ... >

// External stores (Zustand, Redux): pass a getter
<AIAgentProvider state={() => useStore.getState()} ... >
```

One gotcha worth knowing: the getter runs outside React rendering, inside the async agent loop, so it must not call hooks. `state={() => useStore.getState()}` is correct; `state={useStore}` passes the hook itself and throws an invalid hook call the first time the agent reads state.

## The core idea: pull-based state

State values are never sent to the model upfront. The model receives a manifest, key names plus descriptions, in the system prompt, and pulls specific values on demand through an internal `__readState` tool:

```
User: "What's in my cart?"

System prompt lists: user, cart, products (with descriptions)
Agent calls: __readState({ keys: ["cart"] })
Tool returns: { "cart": [{ "product": "Headphones", "qty": 1 }] }
Agent answers: "You have Wireless Headphones in your cart."
```

Two things fall out of this:

- **Token cost scales with what the agent actually reads**, not with the size of your state tree.
- **Unread state never leaves the client.** A key the agent does not ask for is never serialized into a request.

A read is resolved from your state source at the moment the model asks, so the model sees current values, and `options.maxStateBytes` can cap how much any single key contributes (see [Security model](#security-model)).

`__readState` is invisible to you as a consumer. It never appears in `AgentResponse.toolCalls`, the `onToolCall` callback, or `history`. The `state_read` event (below) is the one place you can watch it happen. The rationale and a worked example are in [docs/internals.md](docs/internals.md).

## Security model

The library treats the LLM as an untrusted planner inside a capability sandbox.

**Allowlists.** `canAccess` (state keys) and `canExecute` (tool names) are whitelists. Anything unlisted does not exist from the agent's point of view.

**Two enforcement layers.** Permissions are checked before and after the model call:

1. *Visibility*: the model never sees unlisted keys or tools, so it cannot request what it cannot see.
2. *Execution*: names are re-validated after the model responds. A hallucinated or injected tool name is rejected with status `denied`, and `__readState` requests are re-filtered against `canAccess`.

**Argument validation.** Tool arguments are checked before the handler runs, and before the confirmation prompt, so nobody is asked to approve a malformed call. Two validators are available:

- The default checks arguments against the tool's `parameters` JSON Schema. It covers a deliberate subset (`type`, `properties`, `required`, `items`, `enum`) and ignores keywords outside it, so a richer schema validates on the parts the library understands instead of failing outright. Handlers should still treat args as untrusted, since unvalidated keywords pass through.
- Passing a [Standard Schema](https://standardschema.dev) validator as `schema` (Zod 3.24+, Valibot 1+, ArkType 2+) replaces the subset check with the real thing. The handler receives the validated value, so defaults and transforms apply, and its argument type is inferred from the schema output. `parameters` still supplies the JSON Schema the model sees; the library does not derive one from the schema.

```ts
import { z } from 'zod';

const AddToCart = z.object({ productId: z.string(), qty: z.number().int().positive().default(1) });

registerTool('addToCart', (args) => addToCart(args.productId, args.qty), {
  description: 'Add a product to the cart',
  parameters: {
    type: 'object',
    properties: { productId: { type: 'string' }, qty: { type: 'integer' } },
    required: ['productId'],
  },
  schema: AddToCart, // args is { productId: string; qty: number }
});
```

Annotating the handler is allowed when the annotation matches the schema output. An annotation that disagrees with it is a compile error rather than a silent fallback to the untyped signature. An explicit type argument (`registerTool<T>(...)`) next to an inline `schema` is also a compile error, whether or not the two agree, since the type argument turns inference off; drop it and let the schema supply the type.

**Human confirmation.** Tools registered with `confirm: true` route through your `onConfirm` handler before running. You own the UI: modal, toast, `window.confirm`, anything that resolves a boolean. The handler receives `{ toolName, args, description, signal }`, where `args` is the validated value and `signal` aborts if the interaction is cancelled while your prompt is open. If no handler is provided, the tool is skipped with status `cancelled`. Confirmation is never silently bypassed. Use it for anything irreversible or user-visible.

Abort and confirmation interact in a few ways worth knowing. An approval that arrives after the interaction was aborted does not run the tool; the call is recorded as `cancelled`. If `onConfirm` rejects with an `AbortError`, the call is cancelled the same way. Any other rejection counts as a tool error: the call is recorded with status `error`, the model is told, and the interaction continues.

**State size guard.** One oversized key (a product catalog, a log buffer) can spend the whole context window on a single read. `options.maxStateBytes` caps the serialized size of each key returned by `__readState`; a value over the cap is replaced with a marker carrying the size, the limit, and a preview of the JSON. Unset means no limit.

**Prompt injection.** State often contains user-generated content (reviews, messages, profile fields). Once serialized into the conversation, that content can attempt prompt injection. The permission and confirmation layers are the backstop: an injected instruction can at worst invoke allowlisted tools, and confirmed tools still require a human yes.

**API keys.** Passing `apiKey` to an adapter ships the key to the browser, visible in DevTools. That is for local development only. In production, route through your own backend with `baseURL` plus `headers`:

```ts
const model = openAIAdapter({
  baseURL: '/api/agent',
  headers: { Authorization: `Bearer ${sessionToken}` },
});
```

The backend holds the real key, applies auth and rate limits, and forwards to the LLM provider.

## Adapters

| Adapter | Status | Defaults |
|---------|--------|----------|
| `openAIAdapter` | Built in | OpenAI chat completions; model `gpt-4o`, temperature `0.2` (`null` omits it) |
| `claudeAdapter` | Built in | Anthropic Messages API; model `claude-opus-5`, `maxTokens` `16000`, prompt caching on |
| Ollama | Recipe below | `openAIAdapter` pointed at Ollama's OpenAI-compatible endpoint |
| Custom | Supported | Implement `ModelAdapter` and pass it to the provider |

Both built-in adapters are raw `fetch`, no SDK dependency. Both require either `apiKey` or `baseURL` and throw at construction with neither. A non-2xx response, a network failure, or an unparseable body throws an `AdapterError` carrying `status` and the raw `body` when there was a response; the provider surfaces it as `error.code: 'ADAPTER_ERROR'` with `error.status`, so a 401 and a 429 are telling apart without parsing messages. Both map the provider's stop reason so a truncated or refused answer is reported (see below), and both report cached prompt tokens in `usage.cacheReadTokens` when the API does.

`claudeAdapter` sends the system prompt as a text block with a `cache_control` breakpoint, which caches the tools and system prompt together across calls; `cache: false` sends a plain string instead. Its `promptTokens` is the total input for the call, cached tokens included, with `cacheReadTokens` and `cacheWriteTokens` broken out. The raw content blocks of each assistant response are kept as `providerData` and replayed verbatim on later turns, which is what keeps thinking blocks and their signatures intact (Anthropic rejects a modified one). Failed tool results go back flagged `is_error`. It sends no sampling parameters, since current Claude models reject them.

`openAIAdapter` sends `temperature: 0.2` unless you pass `temperature: null`, which omits the field; reasoning models reject any value other than their own default. Cached prompt tokens come from `prompt_tokens_details.cached_tokens` and are already inside `promptTokens`.

**Ollama.** Ollama exposes an OpenAI-compatible endpoint, so a local model needs no separate adapter:

```ts
const model = openAIAdapter({
  baseURL: 'http://localhost:11434/v1',
  model: 'llama3.1', // pick a model whose Ollama page lists tool support
});
```

The model has to support tool calling, or the agent cannot read state or run anything. I have not run this recipe myself; it follows from the endpoint being OpenAI-compatible, and reports either way are welcome.

## How `send()` behaves

Each `send()` runs a turn loop of at most `options.maxTurns` model round trips (default 5). A few behaviors worth knowing:

- **One at a time.** Concurrent `send()` calls queue and run strictly in call order, each starting from the transcript the previous one left. `history` therefore always alternates user, assistant, and `isProcessing` stays true from the first call until the last queued one settles.
- **Conversation memory.** The prior LLM transcript is replayed with tool calls and their results intact across `send()` calls, so the agent remembers what it already did. `clearHistory()` resets it. Calling `clearHistory()` while an interaction is running discards that interaction's records: its `send()` still resolves and `onError` still fires, but nothing it produced lands in `history`, `lastResponse`, or the transcript.
- **Events.** `options.onEvent` receives `turn_start`, `state_read`, `tool_start`, and `tool_end` as the loop runs, for progress UI and logging. Every `tool_start` gets exactly one `tool_end`; `tool_start` carries the raw arguments from the model and `tool_end` the validated value plus the final status.
- **Cancellation.** `send(message, { signal })` takes an `AbortSignal`. A signal linked to it reaches the adapter, `onConfirm`, and every tool handler as `context.signal`. An abort ends the wait on the adapter, on `onConfirm`, and on the handler even when they ignore the signal; forwarding the signal to `fetch` or whatever else the handler awaits is what stops the work itself, since a promise cannot be cancelled from outside. Aborts resolve with `error.code: 'ABORTED'` rather than throwing, and deliberately do not fire `onError`, since a cancel is a caller decision, not a failure.
- **Unmount.** Unmounting the provider aborts everything it owns. In-flight and queued interactions end with `error.code: 'ABORTED'` the same way a cancel does: `onConfirm`'s `signal` fires, handlers see `context.signal` aborted, `onError` is not called, and `send()` still settles, even when a confirmation UI unmounted without answering or a handler never looks at its signal. A `send()` reached through a stale reference after unmount resolves `ABORTED` without calling the model. StrictMode's simulated unmount in development gets a fresh controller and does not affect later sends.
- **Typed errors.** `error.code` is one of the codes below. Every code except `ABORTED` reaches `onError`. An exception that is not an `AdapterError` (a throwing `onToolCall` callback, for example) produces an error with no code. `send()` resolves with all of these; the one thing that makes it reject is `onError` itself throwing, and by then `history` and `lastResponse` are already written.
- **History carries errors.** The assistant entry of an interaction that ended with an error has that error on `entry.error`, `ABORTED` included, so a chat UI can render a failed turn in place.
- **Token usage.** `AgentResponse.usage` totals tokens across every model call in the interaction, when the adapter reports them. `promptTokens` is the total input including any cached portion; `cacheReadTokens` and `cacheWriteTokens` are subsets of it, present only when a provider reported them.

| `error.code` | Meaning |
|--------------|---------|
| `ABORTED` | The signal fired. Partial tool calls are kept; `onError` is not called |
| `MAX_TURNS` | `maxTurns` ran out while the model was still calling tools; `message` is empty |
| `ADAPTER_ERROR` | The adapter threw an `AdapterError`; `error.status` carries the HTTP status when there was one |
| `TRUNCATED` | The model hit its output token limit; `message` holds the partial text |
| `REFUSED` | The model declined to answer (Anthropic `refusal`, OpenAI `content_filter`); `message` holds whatever text came back |

## API reference

Everything the package exports:

| Export | What it is |
|--------|------------|
| `AIAgentProvider` | Context provider wiring model, state, tools, and permissions together |
| `useAgent()` | Hook to interact with the agent from anywhere in the provider tree |
| `registerTool(name, handler, options?)` | Creates a validated tool definition |
| `openAIAdapter(config)` | OpenAI chat completions adapter |
| `claudeAdapter(config)` | Anthropic Messages API adapter |
| `AdapterError` | Error class thrown by the built-in adapters, with `status` and `body` |
| `validateToolArgs(tool, args)` | Runs a tool's `schema` or `parameters` check and returns the validated value; exported for custom wiring |
| `validateToolNames`, `filterState`, `filterTools`, `validateToolCall` | Building blocks for testing and custom wiring; typical apps never call these |
| Types | `ModelAdapter`, `AgentResponse`, `ToolDefinition`, `ToolHandler`, `ToolContext`, `AgentEvent`, `AgentErrorCode`, `TokenUsage`, `StopReason`, `StandardSchemaV1`, and the rest of `src/types.ts` |

On `registerTool`: a tool needs a `description` to be shown to the model, and omitting `parameters` substitutes the empty object schema. `schema` takes a Standard Schema validator and types the handler from its output. Names beginning with `__` are reserved for internal tools (`__readState`) and rejected on mount, as are duplicate names.

### `<AIAgentProvider>` props

| Prop | Type | Notes |
|------|------|-------|
| `model` | `ModelAdapter` | Required |
| `state` | `object \| (() => object)` | Object for React state, getter for external stores |
| `tools` | `AnyToolDefinition[]` | From `registerTool`; names must be unique, checked on mount |
| `permissions` | `PermissionsConfig` | Required, see below |
| `options` | `AgentOptions` | Optional, see below |
| `children` | `React.ReactNode` | |

### `PermissionsConfig`

| Field | Type | Notes |
|-------|------|-------|
| `canAccess` | `string[]` | State keys the agent may read |
| `canExecute` | `string[]` | Tool names the agent may invoke |
| `stateDescriptions` | `Record<string, string>` | Optional per-key descriptions for the manifest; missing entries fall back to the key name |

### `AgentOptions`

| Field | Type | Notes |
|-------|------|-------|
| `debug` | `boolean` | Verbose console logging, prefixed `[react-observer-agent]` (default `false`) |
| `maxTurns` | `number` | Max LLM round trips per `send()` (default `5`) |
| `maxStateBytes` | `number` | Per-key size cap on `__readState` results; oversized values become a truncation marker (default: no limit) |
| `systemPrompt` | `string` | Prepended to the generated state manifest prompt |
| `onError` | `(error: AgentError) => void` | Called when an interaction fails (except `ABORTED`) |
| `onToolCall` | `(call: ToolCallEvent) => void` | Observer for every user-tool outcome |
| `onConfirm` | `(call: PendingToolCall) => Promise<boolean>` | Approval handler for `confirm: true` tools; `call.signal` aborts with the interaction |
| `onEvent` | `(event: AgentEvent) => void` | Observer for `turn_start`, `state_read`, `tool_start`, `tool_end` |

### `AgentEvent`

| `type` | Fields | When |
|--------|--------|------|
| `turn_start` | `turn`, `maxTurns` | Right before each model call |
| `state_read` | `requested`, `keys` | After a `__readState` call resolves; `keys` is the allowed subset actually read |
| `tool_start` | `toolName`, `args` | Before the permission check, with the raw arguments |
| `tool_end` | `toolName`, `args`, `result`, `status` | Once per `tool_start`, with the validated arguments and final status |

### `useAgent()` returns

| Field | Type | Notes |
|-------|------|-------|
| `send` | `(message, options?) => Promise<AgentResponse>` | Queued; `options.signal` cancels; resolves rather than rejects on errors, unless `onError` itself throws |
| `isProcessing` | `boolean` | True while any `send()` is pending or running |
| `history` | `ConversationEntry[]` | User-facing conversation history; assistant entries carry `error` when the interaction failed |
| `clearHistory` | `() => void` | Resets history, the LLM transcript, and `lastResponse` |
| `lastResponse` | `AgentResponse \| null` | Most recent response, including error responses |

### `AgentError`

| Field | Type | Notes |
|-------|------|-------|
| `message` | `string` | |
| `code` | `AgentErrorCode` | `'ABORTED' \| 'MAX_TURNS' \| 'ADAPTER_ERROR' \| 'TRUNCATED' \| 'REFUSED'`; absent for other thrown exceptions |
| `status` | `number` | HTTP status, when the failure came from an adapter with one |
| `cause` | `unknown` | The original exception, when there was one |

### Adapter config

| Option | `openAIAdapter` | `claudeAdapter` |
|--------|-----------------|-----------------|
| `apiKey` | Dev only | Dev only |
| `baseURL` | Proxy or alternate endpoint | Proxy or alternate endpoint |
| `model` | Default `gpt-4o` | Default `claude-opus-5` |
| `headers` | Extra request headers | Extra request headers, spread last |
| `temperature` | Default `0.2`; `null` omits the field | Not sent |
| `maxTokens` | Not sent | Default `16000` |
| `cache` | Not applicable | Default `true`; `false` disables prompt caching |

Tool call statuses in `AgentResponse.toolCalls`, `onToolCall`, and `tool_end`: `success`, `confirmed`, `cancelled`, `denied`, `error`. When a handler throws or `onConfirm` rejects, `result` keeps the text of what was thrown: an `Error`'s message, a thrown string as is, the `message` of a rejected object, other objects JSON-stringified, `'Unknown error'` for `null` or `undefined`. The model is told the same text.

The full contracts, including the `ModelAdapter` interface for writing custom adapters, are in [SPEC.md](SPEC.md).

## What's next

In rough priority order:

1. Streaming responses
2. Transcript compaction, so long sessions stay under the context window
3. Per-tool permission scoping

Explicit non-goals for now: DOM awareness and page context mapping, automatic state detection, multi-agent orchestration, persistent memory, built-in rate limiting.

## Docs and examples

- [reactobserveragent.sudo-ezekiel.com](https://reactobserveragent.sudo-ezekiel.com): guides, API reference, and live examples you can click through
- [sudo-ezekiel/react-observer-agent-examples](https://github.com/sudo-ezekiel/react-observer-agent-examples): the source for that site, including a runnable Zustand shopping app that proxies both providers
- [SPEC.md](SPEC.md): the full technical spec
- [docs/internals.md](docs/internals.md): pull-based state rationale, the interaction queue, events, and execution loop detail
- [CHANGELOG.md](CHANGELOG.md)

## Disclaimer

This is a solo experiment. It is **not production-ready**. It may change, break, or stop at any time.

If you are curious about intelligent UIs, you are welcome to explore it, fork it, or reach out. Feedback is appreciated.

## License

MIT
