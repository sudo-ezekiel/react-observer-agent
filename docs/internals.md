# Internals

Technical documentation for contributors and maintainers. This covers how `react-observer-agent` works under the hood.

---

## Pull-Based State (`__readState`)

### Problem

The naive approach to giving an AI agent access to app state is to dump the entire (filtered) state into the LLM context on every interaction. This has two issues:

1. **Token waste.** For apps with large state trees, most of the state is irrelevant to any given question.
2. **No differentiation.** The library becomes syntactic sugar over "serialize state + call LLM", which any developer can do in 10 lines.

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

1. **State manifest.** On each interaction, `canAccess` keys are mapped to `{ key, description }` pairs. Descriptions come from `permissions.stateDescriptions` (falls back to the key name).

2. **System prompt injection.** The manifest is appended to the user's `systemPrompt` (or used alone if none is provided). The injected text lists available keys and instructs the agent to use `__readState`.

3. **Internal `__readState` tool.** Automatically added to the LLM's tool list when `canAccess` has at least one key. Its schema:
   ```json
   {
     "name": "__readState",
     "description": "Read specific keys from the application state. Only request keys you need.",
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

4. **Argument validation.** The call is checked against that schema with the same built-in validator user tools get. A model that sends `keys` as a string used to crash the loop; now it gets a tool message `{ error: "Invalid arguments for __readState: ..." }` flagged `isError` and the turn continues. Nothing else is recorded for an invalid read. Non-string entries are filtered out defensively even when validation passes.

5. **Permission enforcement.** When `__readState` is called, only keys present in `canAccess` are resolved. Unauthorized keys are silently filtered out, so the agent never sees values it should not.

6. **State resolution.** The state source (object or getter function) is resolved on demand via `createStateSnapshot()`, once per `__readState` call rather than once per interaction.

7. **Size guard.** `createStateSnapshot` takes `options.maxStateBytes` as its fourth argument. After stripping non-serializable values, each remaining key's JSON is measured; a key over the limit is replaced with this marker:
   ```json
   {
     "__truncated": true,
     "limit": 20000,
     "bytes": 83120,
     "preview": "[{\"id\":\"sku-1\",\"name\":..."
   }
   ```
   `bytes` is the actual JSON length and `preview` the first `limit` characters of it. The limit is per key, so a read of three keys can return up to three times the limit. Debug mode warns for each truncated key. Unset means no limit, and the marker shape is stable so a system prompt can tell the model what it means.

### What the User Sees

`__readState` is **completely internal**. It does not appear in:

- `AgentResponse.toolCalls`. Only user-defined tools are included.
- The `onToolCall` callback. Not fired for readState.
- `history` / `ConversationEntry[]`. The user-facing history only includes the final agent text response.

The one consumer-facing trace is the `state_read` event on `onEvent`, which carries the keys the model asked for and the allowed subset that was actually read. It exists for progress UI and debugging and carries no values.

The LLM conversation internally contains readState calls (so the agent can reason over multiple turns), but these are stripped from all other consumer-facing outputs.

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
  options={{ maxStateBytes: 20_000 }}             // optional
>
```

- **`stateDescriptions`** is optional. If omitted, the key name itself is used as the description. Providing descriptions helps the LLM understand what each key contains without reading it.
- **`maxStateBytes`** is optional. Set it when any key can grow without bound (catalogs, logs, cached API responses).

### What adapters receive

Two `ModelRequest` fields follow from the pull model:

| Field | Value | Notes |
|-------|-------|-------|
| `state` | Always `{}` | Vestigial. State values never travel with the request. |
| `stateManifest` | `[{ key: string, description: string }]` | Informational, already rendered into `systemPrompt`. |

Adapter authors can use `stateManifest` to build richer system prompts if desired. The loop injects it into `systemPrompt` either way.

---

## Interaction Queue

`send()` is serialized per provider. The provider keeps four refs for this:

- **`queueRef`** holds the tail promise of the queue. Each `send()` chains `runInteraction` onto it and replaces the tail with the new promise, swallowing its rejection so one broken interaction cannot stall the ones queued behind it. The caller still receives whatever its own interaction settled with. `onError` is dispatched after the try/catch and after the generation-guarded state writes, so a throwing handler rejects the caller's promise without appending a second assistant entry, overwriting `lastResponse`, or firing `onError` again.
- **`pendingRef`** counts calls that have been made but not settled. `isProcessing` is derived from `pendingRef > 0`, set synchronously in `send()` and cleared in a `finally`, so it goes true at the first call and stays true across the queue without flickering false between two queued interactions.
- **`generationRef`** is bumped by `clearHistory()`. An interaction captures the generation when it starts and, on finishing, writes to the transcript, `history`, and `lastResponse` only if the generation is unchanged. A clear that lands mid-interaction therefore discards that interaction's records entirely: its user entry went with the clear, and its assistant entry never lands. The `send()` promise still resolves normally and `onError` still fires under the usual rules, since those belong to the caller rather than to the conversation. `runInteraction` captures `optionsRef.current` next to the generation and uses that one object for the loop and for the final `onError`, so a re-render with a new inline `options` object mid-interaction cannot redirect the error to a handler the interaction did not start with.
- **`unmountRef`** holds an `AbortController` the provider aborts in its mount effect's cleanup. It is created lazily, because a child can call `send()` from its own mount effect, which runs before the provider's. Every interaction runs under `linkSignals(sendOptions.signal, unmountController.signal)` (`src/utils/linkSignals.ts`), a signal that aborts as soon as either source does and carries the source's abort reason; `release()` in the interaction's `finally` drops the listeners, since a caller signal can outlive many interactions. Unmount therefore ends in-flight and queued interactions with `ABORTED` through the same checks a caller cancel goes through, and a `send()` through a stale reference after unmount links to the already-aborted controller and returns `ABORTED` at the loop's first check. After a real unmount the aborted controller stays put; only the mount effect replaces it, which is what keeps StrictMode's simulated unmount and remount from poisoning later sends.

Two consequences of the queue:

- The user history entry is appended when the queued call **starts executing**, not when `send()` was called. Appending at call time would let two rapid sends produce user, user, assistant, assistant. With the queue, `history` always alternates.
- A queued call whose signal was aborted while it waited still enters the loop, which returns `ABORTED` on its first check without calling the model. It gets its user and assistant entries like any other interaction.

Without the queue, two overlapping sends both started from the same transcript ref and the second to finish overwrote the first's transcript, losing a turn the model had already seen.

---

## Event Stream

`options.onEvent` receives `AgentEvent` values as the loop runs. Within one interaction the order is:

```
turn_start (turn 1)
  state_read           (per valid __readState call)
  tool_start / tool_end (per user tool call, always paired)
turn_start (turn 2)
  ...
```

Guarantees the loop keeps:

- **One `tool_end` per `tool_start`.** `tool_start` fires for every user tool the model requested, before the permission check. `tool_end` fires through the single `record()` helper, which also pushes the `toolCalls` entry and calls `onToolCall`. Every branch after `tool_start` (denied, not found, invalid arguments, cancelled, error, success) goes through `record()` exactly once, including the abort paths that end the interaction mid-call: `cancelForAbort()` records a `cancelled` end before returning.
- **`tool_start` carries the raw arguments; `tool_end` carries the validated value.** `tool_start` fires before validation, so it can only carry what the model sent. Once validation succeeds, the value it returned (which a Standard Schema may have transformed or defaulted) is what the confirmation prompt, the handler, `toolCalls`, `onToolCall`, and `tool_end` all see. On the `denied` and invalid-arguments paths there is no validated value, so `tool_end` carries the raw arguments there.
- **Reporting happens after the handler try/catch, not inside it.** Only the handler call and `JSON.stringify({ result })` sit inside the try. The outcome is captured and then reported once. A throwing `onToolCall` or `onEvent` callback therefore propagates out of the loop (the provider turns it into an untyped error response) instead of being caught as a handler failure and reported a second time.
- **`state_read` is the only event for `__readState`.** An invalid read emits nothing.

Events are observation only. There is no return value and no way to veto a call; that is what `onConfirm` and the permission layers are for.

---

## Execution Loop

The agent execution loop (`executeAgentLoop`) handles the full lifecycle of a `send()` call:

```
1. Build state manifest from canAccess + stateDescriptions
2. Filter tools by canExecute (a tool needs a description to be visible;
   a missing parameters schema defaults to the empty object schema)
3. Inject __readState tool (if canAccess has keys)
4. Build system prompt = user systemPrompt + state manifest prompt
5. Enter turn loop (max: maxTurns, default: 5):
   a. Abort check, emit turn_start, send messages + tools to LLM via adapter
   b. Accumulate reported token usage
   c. If no tool calls, this is the answer: stopReason max_tokens marks it
      TRUNCATED, refusal marks it REFUSED; break either way
   d. Push the assistant message with its toolCalls and providerData
   e. For each tool call:
      - __readState: validate, resolve allowed keys under maxStateBytes,
        emit state_read, push result to messages (internal)
      - User tools: emit tool_start, check canExecute and definition,
        validate arguments (validateToolArgs, async), abort re-check,
        confirmation flow, execute handler(value, { signal }), serialize,
        record once (toolCalls entry + onToolCall + tool_end), push result
   f. Loop back to (a) with updated messages
6. Push the final assistant message if its content is non-empty
7. Return { response, messages }: the AgentResponse plus the LLM transcript
```

Exhausting the loop without a text answer returns `error.code: 'MAX_TURNS'`; an abort returns `'ABORTED'`; a cut-off or refused answer returns its text with `'TRUNCATED'` or `'REFUSED'`. None throw. Adapter exceptions propagate to the provider, which converts an `AdapterError` to `{ code: 'ADAPTER_ERROR', status }` and anything else to a code-less error response.

Abort is checked at each turn start, after the model call, before each tool call, after argument validation (which can await a schema), and after `onConfirm` resolves (which can take as long as the user likes). A handler that forwards the signal and rejects with an `AbortError` after the signal fired is recorded as `cancelled`, not as an error; the same applies to an `onConfirm` that rejects with an `AbortError`. Any other `onConfirm` rejection is a tool error and the loop continues.

Those checks only run once consumer code hands control back, and it may never do so: a confirmation whose UI unmounted with the provider never answers, and a handler or adapter that ignores its signal can run for as long as it likes. Awaiting them bare meant an abort set the signal and nothing else happened, so the interaction parked, `send()` never settled, and the queue behind it never drained. The model call, the `onConfirm` await, and the handler await are therefore each raced against `abortRace(signal).promise` (`src/utils/abortRace.ts`), a promise that never settles on its own and rejects with an `AbortError` once the signal fires; the existing catch blocks treat that rejection as a cancel. The race gives the loop back and nothing more. The consumer promise cannot be cancelled, so a handler that ignores its signal runs to completion in the background and its result is dropped on arrival. Each race's `release()` runs in a `finally` to remove the abort listener, because a caller signal can outlive many interactions and the listeners would otherwise accumulate on it, one per guarded await. `abortRace` also normalizes the reason: a signal aborted with anything other than an `AbortError` rejects with a fresh `AbortError`, so `isAbortError` recognizes it.

### Tool Call Statuses

| Status | Meaning | `isError` on the tool message |
|--------|---------|-------------------------------|
| `success` | Tool executed normally (no confirmation required) | no |
| `confirmed` | Tool with `confirm: true` was approved and executed | no |
| `cancelled` | Tool with `confirm: true` was denied or had no `onConfirm` handler, or the interaction was aborted during validation, confirmation, or the handler | no |
| `denied` | Tool name not in `canExecute`, or in it with no matching definition (defense-in-depth) | yes |
| `error` | Handler threw, result not serializable, arguments failed validation, or `onConfirm` rejected with a non-abort error | yes |

`isError` reaches the Anthropic API as `is_error: true` on the `tool_result` block. OpenAI has no equivalent flag, so its adapter ignores the field.

The text recorded for a thrown handler or a rejected `onConfirm` comes from `describeError` (`src/utils/describeError.ts`), which the loop, the provider, both adapters, and `validateToolArgs` share: an `Error`'s `message` (then its `name`, then the fallback, if empty), a string as is, the `message` of an object that carries one, `JSON.stringify` of any other object when it yields more than `'{}'`, and `'Unknown error'` for `null`, `undefined`, or a value that cannot be serialized.

### Debug Logging

When `options.debug` is `true`, the execution loop logs:

- State manifest keys
- Available tools (including `__readState`)
- Turn count
- LLM request metadata (message count, tool count, has system prompt)
- LLM response summary (truncated content, tool call names)
- `readState` requested vs allowed keys and results
- Invalid `__readState` arguments
- State keys truncated by `maxStateBytes`
- Tool execution results
- Tools hidden from the LLM for lacking a description
- Argument validation failures
- Missing `onConfirm` handler for a `confirm: true` tool
- `maxTurns` reached

All logs are prefixed with `[react-observer-agent]`.

---

## Structured Replay

The provider keeps two records of a conversation, and they are not the same thing:

- **`history`** (`ConversationEntry[]`) is the user-facing record, exposed through `useAgent()`. One entry per user message and one per assistant response, with tool activity attached to the assistant entry and, when the interaction failed, the error on `entry.error`.
- **The transcript** (`ConversationMessage[]`) is the LLM-facing record, held in a ref and never exposed. It carries assistant messages with their `toolCalls` intact and the tool result messages answering them.

`executeAgentLoop` returns the transcript alongside the response, and the provider replays it verbatim on the next `send()`. Before this, history was flattened to role and content text, which cannot express a tool call, so the agent lost track of what it had already done between interactions.

### Provider data

Some providers hand back content the loop does not understand but must return unchanged. Anthropic's extended thinking is the concrete case: a response can carry `thinking` blocks with a cryptographic `signature`, and a later request that replays that assistant turn must include those blocks byte for byte or the API rejects it. The loop cannot rebuild them from `content` and `toolCalls` because it never parsed them.

So `ModelResponse.providerData` is opaque. The Claude adapter sets it to the raw `content` block array of every response; the loop copies it onto every assistant message it pushes (the tool-calling ones and the final one); and on replay, the adapter sends an assistant message carrying a non-empty `providerData` array as exactly those blocks, skipping its own text and `tool_use` reconstruction. A transcript from 0.2.0, or a message a custom source built by hand, has no `providerData` and takes the reconstruction path as before.

The OpenAI adapter sets no `providerData` today. Nothing in its wire format needs to survive a round trip beyond `tool_calls`, which `toolCalls` already carries.

### Transcript hygiene

Some message shapes are never written to the transcript, and adapters defend against the rest:

- **Aborted turns are dropped.** A cancel can land after the assistant message announcing tool calls but before the results answering them. Both OpenAI and Anthropic reject that shape, so replaying it would break the next request outright. The partial turn is dropped.
- **Turns whose adapter threw are dropped.** Nothing coherent happened, so there is nothing worth replaying.
- **An empty final assistant message is not persisted.** A model that stops with no text and no tool calls (a truncation at zero tokens, a refusal with no explanation) would leave an assistant message with `content: ''`, which both providers reject on replay. The loop only pushes the final message when its content is non-empty. The response still reports the empty `message` and its `TRUNCATED` or `REFUSED` code; only the transcript skips it.
- **Adapters skip empty assistant messages anyway.** Both built-in adapters drop an assistant message whose content is empty and which carries no tool calls, so a transcript written by 0.2.0 (which did persist them) or by a custom source still sends cleanly.
- **A cleared conversation stays cleared.** The generation guard described under Interaction Queue keeps a finishing interaction from writing its transcript back over a `clearHistory()`.

Two consequences worth knowing:

- **Replayed `__readState` results are point-in-time.** They hold the values read when the tool ran, not current values. The manifest instruction tells the model to read again when it needs fresh state.
- **The transcript grows.** `maxTurns` bounds growth within one interaction, but nothing bounds it across interactions. `clearHistory()` resets both records. Compaction is on the roadmap.

Adapters receive a snapshot of the message list rather than the live array, so holding onto it across awaits never exposes later turns.
