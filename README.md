![ShowCase](https://github.com/user-attachments/assets/84c38dc6-7f62-4c37-8d96-3b3eac489140)

# react-observer-agent

A React library that lets an LLM agent observe your app's state, understand what the user is doing, and execute pre-defined actions, all through a declarative `<AIAgentProvider>` and registered tools, with permission boundaries built in.

This is an experimental project by a solo developer. I am exploring whether an AI agent can be useful inside a live React app without dumping your whole state into a prompt or letting the model run arbitrary code. It works and it is tested, but it remains a research project rather than a product. See the [disclaimer](#disclaimer).

- Zero runtime dependencies (adapters use raw `fetch`, no SDKs)
- TypeScript, dual ESM/CJS builds with types included
- React >= 18 (peer dependency)
- Works with any state manager: Zustand, Redux, vanilla React state

## Install

```bash
npm install react-observer-agent
```

## Quick start

```tsx
import { AIAgentProvider, registerTool, openAIAdapter, useAgent } from 'react-observer-agent';
import { useStore } from './store';

// 1. Register tools: actions the agent is allowed to perform
const tools = [
  registerTool('goToPage', (args: { path: string }) => navigate(args.path), {
    description: 'Navigate to a page in the app',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }),
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
        canExecute: ['goToPage', 'submitForm'],
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

`__readState` is invisible to you as a consumer. It never appears in `AgentResponse.toolCalls`, the `onToolCall` callback, or `history`. The rationale and a worked example are in [docs/internals.md](docs/internals.md).

## Security model

The library treats the LLM as an untrusted planner inside a capability sandbox.

**Allowlists.** `canAccess` (state keys) and `canExecute` (tool names) are whitelists. Anything unlisted does not exist from the agent's point of view.

**Two enforcement layers.** Permissions are checked before and after the model call:

1. *Visibility*: the model never sees unlisted keys or tools, so it cannot request what it cannot see.
2. *Execution*: names are re-validated after the model responds. A hallucinated or injected tool name is rejected with status `denied`, and `__readState` requests are re-filtered against `canAccess`.

**Human confirmation.** Tools registered with `confirm: true` route through your `onConfirm` handler before running. You own the UI: modal, toast, `window.confirm`, anything that resolves a boolean. If no handler is provided, the tool is skipped with status `cancelled`. Confirmation is never silently bypassed. Use it for anything irreversible or user-visible.

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
| `openAIAdapter` | Shipped | OpenAI chat completions; model `gpt-4o`, temperature `0.2` |
| `claudeAdapter` | Shipped | Anthropic Messages API; model `claude-opus-5`, `maxTokens` `16000` |
| `ollamaAdapter` | Planned | Local models via Ollama |
| Custom | Supported | Implement `ModelAdapter` and pass it to the provider |

Both built-in adapters are raw `fetch`, no SDK dependency. Both require either `apiKey` or `baseURL` and throw at construction with neither. `claudeAdapter` sends no sampling parameters, since current Claude models reject them.

## What shipped in v0.2.0

Beyond the Claude adapter, v0.2.0 added:

- **Cancellation.** `send(message, { signal })` takes an `AbortSignal`. Aborts resolve with `error.code: 'ABORTED'` rather than throwing, and deliberately do not fire `onError`, since a cancel is a caller decision, not a failure.
- **Runtime argument validation.** Tool arguments are checked against the tool's `parameters` JSON Schema before the handler runs, and before the confirmation prompt, so nobody is asked to approve a malformed call. Validation covers a deliberate subset (`type`, `properties`, `required`, `items`, `enum`) and ignores keywords outside it, so a richer schema validates on the parts the library understands instead of failing outright. Handlers should still treat args as untrusted.
- **Structured conversation replay.** The prior LLM transcript is replayed with tool calls and their results intact across `send()` calls, so the agent remembers what it already did.
- **`AgentResponse.usage`**: prompt and completion tokens totalled across every model call in the interaction, when the adapter reports them.
- **Typed `MAX_TURNS` error** when the turn budget (default 5, configurable via `options.maxTurns`) runs out while the model is still calling tools.

Also worth knowing: a tool needs a `description` to be shown to the model, and omitting `parameters` substitutes the empty object schema. Names beginning with `__` are reserved for internal tools and rejected on mount.

Full details in [CHANGELOG.md](CHANGELOG.md).

## API reference

Everything the package exports:

| Export | What it is |
|--------|------------|
| `AIAgentProvider` | Context provider wiring model, state, tools, and permissions together |
| `useAgent()` | Hook to interact with the agent from anywhere in the provider tree |
| `registerTool(name, handler, options?)` | Creates a validated tool definition |
| `openAIAdapter(config)` | OpenAI chat completions adapter |
| `claudeAdapter(config)` | Anthropic Messages API adapter |
| `validateToolNames`, `filterState`, `filterTools`, `validateToolCall` | Building blocks for testing and custom wiring; typical apps never call these |
| Types | `ModelAdapter`, `AgentResponse`, `ToolDefinition`, and the rest of `src/types.ts` |

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
| `systemPrompt` | `string` | Prepended to the generated state manifest prompt |
| `onError` | `(error: AgentError) => void` | Called when an interaction fails (except `ABORTED`) |
| `onToolCall` | `(call: ToolCallEvent) => void` | Observer for every user-tool outcome |
| `onConfirm` | `(call: PendingToolCall) => Promise<boolean>` | Approval handler for `confirm: true` tools |

### `useAgent()` returns

| Field | Type | Notes |
|-------|------|-------|
| `send` | `(message, options?) => Promise<AgentResponse>` | `options.signal` cancels; resolves rather than rejects on errors |
| `isProcessing` | `boolean` | True while an interaction is in flight |
| `history` | `ConversationEntry[]` | User-facing conversation history for this provider instance |
| `clearHistory` | `() => void` | Resets history, the LLM transcript, and `lastResponse` |
| `lastResponse` | `AgentResponse \| null` | Most recent response, including error responses |

Tool call statuses in `AgentResponse.toolCalls` and `onToolCall`: `success`, `confirmed`, `cancelled`, `denied`, `error`.

The full contracts, including the `ModelAdapter` interface for writing custom adapters, are in [SPEC.md](SPEC.md).

## Roadmap

Done in v0.2.0: tool registry, pull-based state, two-layer permissions, confirmation flow, argument validation, abort support, structured replay, usage aggregation, OpenAI and Claude adapters, debug logging.

Next, in rough priority order:

1. `ollamaAdapter` for local models
2. Streaming responses
3. Deeper argument validation
4. Transcript compaction, so long sessions stay under the context window
5. Per-tool permission scoping

Explicit non-goals for now: DOM awareness and page context mapping, automatic state detection, multi-agent orchestration, persistent memory, built-in rate limiting.

## Docs and examples

- [SPEC.md](SPEC.md): the full technical spec
- [docs/internals.md](docs/internals.md): pull-based state rationale and execution loop detail
- [CHANGELOG.md](CHANGELOG.md)
- [examples/basic](examples/basic): a runnable Zustand shopping app that proxies both providers, with a smoke test script

## Disclaimer

This is a solo experiment. It is **not production-ready**. It may change, break, or stop at any time.

If you are curious about intelligent UIs, you are welcome to explore it, fork it, or reach out. Feedback is appreciated.

## License

MIT
