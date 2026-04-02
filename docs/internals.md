# Internals

Technical documentation for contributors and maintainers. This covers how `react-observer-agent` works under the hood.

---

## Pull-Based State (`__readState`)

### Problem

The naive approach to giving an AI agent access to app state is to dump the entire (filtered) state into the LLM context on every interaction. This has two issues:

1. **Token waste** — For apps with large state trees, most of the state is irrelevant to any given question.
2. **No differentiation** — The library becomes syntactic sugar over "serialize state + call LLM", which any developer can do in 10 lines.

### Solution

State is **not sent upfront**. Instead, the agent receives a **manifest** (key names + descriptions) and pulls specific values on demand via an internal `__readState` tool.

```
User: "What's in my cart?"

System prompt includes:
  Available application state (use __readState to access specific keys):
  - user: Current logged-in user profile
  - cart: Shopping cart items and quantities
  - products: Available product catalog

Agent calls: __readState({ keys: ["cart"] })
Tool returns: { "cart": [{ "product": "Headphones", "qty": 1 }] }

Agent responds: "You have Wireless Headphones in your cart."
```

### How It Works

1. **State manifest** — On each interaction, `canAccess` keys are mapped to `{ key, description }` pairs. Descriptions come from `permissions.stateDescriptions` (falls back to the key name).

2. **System prompt injection** — The manifest is appended to the user's `systemPrompt` (or used alone if none is provided). The injected text lists available keys and instructs the agent to use `__readState`.

3. **Internal `__readState` tool** — Automatically added to the LLM's tool list when `canAccess` has at least one key. Its schema:
   ```json
   {
     "name": "__readState",
     "description": "Read specific keys from the application state.",
     "parameters": {
       "type": "object",
       "properties": {
         "keys": {
           "type": "array",
           "items": { "type": "string" },
           "description": "State keys to read"
         }
       },
       "required": ["keys"]
     }
   }
   ```

4. **Permission enforcement** — When `__readState` is called, only keys present in `canAccess` are resolved. Unauthorized keys are silently filtered out — the agent never sees values it shouldn't.

5. **State resolution** — The state source (object or getter function) is resolved on demand via `createStateSnapshot()`, the same function used before the refactor. The difference is it's now called per-`readState` call, not once upfront.

### What the User Sees

`__readState` is **completely internal**. It does not appear in:

- `AgentResponse.toolCalls` — Only user-defined tools are included.
- `onToolCall` callback — Not fired for readState.
- `history` / `ConversationEntry[]` — The user-facing history only includes the final agent text response.

The LLM conversation internally contains readState calls (so the agent can reason over multiple turns), but these are stripped from all consumer-facing outputs.

### Configuration

```tsx
<AIAgentProvider
  model={model}
  state={() => useStore.getState()}
  tools={tools}
  permissions={{
    canAccess: ['user', 'cart', 'products'],
    canExecute: ['addToCart', 'clearCart'],
    stateDescriptions: {                          // optional
      user: 'Current logged-in user profile',
      cart: 'Shopping cart items and quantities',
      products: 'Available product catalog',
    },
  }}
>
```

- **`stateDescriptions`** is optional. If omitted, the key name itself is used as the description. Providing descriptions helps the LLM understand what each key contains without reading it.

### ModelRequest Changes

The `ModelRequest` sent to adapters now includes:

| Field | Before | After |
|-------|--------|-------|
| `state` | Filtered state values | `{}` (empty) |
| `stateManifest` | _(didn't exist)_ | `[{ key: string, description: string }]` |

Adapter authors can use `stateManifest` to build richer system prompts if desired. The default behavior injects it into `systemPrompt` automatically.

---

## Execution Loop

The agent execution loop (`executeAgentLoop`) handles the full lifecycle of a `send()` call:

```
1. Build state manifest from canAccess + stateDescriptions
2. Filter tools by canExecute
3. Inject __readState tool (if canAccess has keys)
4. Build system prompt = user systemPrompt + state manifest prompt
5. Enter turn loop (max: maxTurns, default: 5):
   a. Send messages + tools to LLM via model adapter
   b. If text-only response → break with final message
   c. If tool calls:
      - __readState → resolve requested keys, push result to messages (internal)
      - User tools → validate permissions → confirmation flow → execute → push result
   d. Loop back to (a) with updated messages
6. Return AgentResponse { message, toolCalls }
```

### Tool Call Statuses

| Status | Meaning |
|--------|---------|
| `success` | Tool executed normally (no confirmation required) |
| `confirmed` | Tool with `confirm: true` was approved and executed |
| `cancelled` | Tool with `confirm: true` was denied or no `onConfirm` handler |
| `denied` | Tool name not in `canExecute` (defense-in-depth) |
| `error` | Tool handler threw an exception |

### Debug Logging

When `options.debug` is `true`, the execution loop logs:

- State manifest keys
- Available tools (including `__readState`)
- Turn count
- LLM request metadata (message count, tool count, has system prompt)
- LLM response summary (truncated content, tool call names)
- `readState` requested vs allowed keys and results
- Tool execution results

All logs are prefixed with `[react-observer-agent]`.
