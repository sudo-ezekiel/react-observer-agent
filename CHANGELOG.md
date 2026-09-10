# Changelog

## 0.3.1

No functional change. `dist` is byte for byte identical to 0.3.0.

0.3.0 was published from a working tree rather than from `main`, a few minutes before the commit it contained
was merged. The code that went out was correct, but the release was not reproducible from a tagged commit.
This releases the same code from `main`, with the tag on the release commit.

## 0.3.0

### Fixed

- **Overlapping `send()` calls corrupted the conversation.** Two sends in flight at once both started from the same transcript, the second to finish overwrote the first's turns, and their history entries interleaved as user, user, assistant, assistant. `send()` now queues; see Changed.
- **A malformed `__readState` call crashed the interaction.** A model that sent `keys` as a string instead of an array threw inside the loop and the whole `send()` failed. The arguments are now validated against the tool's own schema, and a bad call gets an error tool message so the model can retry.
- **A confirmation answered after the interaction was aborted still ran the tool.** `onConfirm` can take as long as the user likes, and an approval that arrived after the signal fired executed the handler anyway. The signal is now re-checked after confirmation (and after async argument validation), and a stale approval records the call as `cancelled`.
- **A tool result that could not be serialized was recorded twice.** The loop pushed the `toolCalls` entry and fired `onToolCall` as a success, then hit `JSON.stringify` on the way to the transcript, threw, and recorded the same call again as an error. Serialization now happens before anything is recorded, and a non-serializable result is a single `error` outcome.
- **A tool name that passed `canExecute` but had no registered definition was denied silently.** The call landed in `toolCalls` as `denied` without firing `onToolCall`. It now reports like every other denial.
- **An `onConfirm` handler that rejected took down the interaction.** A confirmation UI that unmounts on cancel typically rejects rather than resolves, and that rejection propagated out of the loop as an untyped failure. A rejection with an `AbortError` (or any rejection after the signal fired) now cancels the call; any other rejection is recorded as a tool `error` and the loop continues.
- **A tool that threw anything other than an `Error` was reported as `Unknown error`.** A thrown string, or a rejection with a plain `{ code, message }` object, now keeps its text in `toolCalls[].result`, `onToolCall`, `tool_end`, and the `isError` tool message the model sees. Other objects are JSON-stringified; `null` and `undefined` still read `Unknown error`. The same helper reads `onConfirm` rejections, schema validator throws, and adapter network failures.
- **A throwing `onError` callback was reported twice.** The throw landed in the interaction's own catch, which appended a second assistant entry, overwrote `lastResponse`, and called `onError` again. `onError` now runs after the interaction's records are written; a throw from it propagates out of `send()` as a rejection, once, and the queue continues with the next call.
- **An unmounted provider could leave an interaction, and everything queued behind it, pending forever.** Unmount aborted the signal, but the loop still awaited `onConfirm`, the tool handler, and the adapter bare. A confirmation whose UI unmounted with the provider never answered, so `send()` never settled, later sends on that provider never ran, and `isProcessing` never returned to false. A handler or adapter that ignored the signal left a caller-side cancel waiting for it to finish. All three awaits are now raced against the signal, so an abort ends the wait at once: the call in flight is recorded `cancelled`, the interaction resolves `ABORTED`, and `onError` is not called. The work itself cannot be cancelled from outside; a handler that ignores `context.signal` runs to completion in the background and its result is discarded. Forward the signal to stop it.
- **A thrown value whose property access itself threw escaped the catch.** `describeError` reads `message` off whatever a handler, adapter, or validator threw; a getter that raised, or a Proxy that trapped, threw again out of the catch block and killed the interaction. Such values now read `Unknown error`.
- **A re-render mid-interaction could redirect the error to a new `onError`.** The provider now captures `options` once when an interaction starts and uses that object for every callback, the final `onError` included.
- **The tools barrel (`src/tools/index.ts`) had broken relative imports.** tsup never bundled it, so nothing caught it. The package entry point never imported it either, so no published build was affected.

### Added

- **Standard Schema validation.** `registerTool` accepts a `schema` option holding any [Standard Schema](https://standardschema.dev) validator (Zod 3.24+, Valibot 1+, ArkType 2+). When present it replaces the built-in JSON Schema subset check, the handler receives the validated value (so defaults and transforms apply), and the handler's argument type is inferred from the schema output. `parameters` still supplies the JSON Schema the model sees. The package carries its own copy of the interface and stays dependency free.
- **Tool handler context.** Handlers are called as `handler(args, { signal })`. `context?.signal` is the interaction's `AbortSignal`, for forwarding to `fetch` or any other long-running work. `PendingToolCall` passed to `onConfirm` carries the same `signal`, so a confirmation UI can close itself when the interaction is cancelled underneath it.
- **`onEvent`.** An observation stream with four events: `turn_start`, `state_read`, `tool_start`, and `tool_end`. Every `tool_start` gets exactly one `tool_end`; `tool_start` carries the raw arguments and `tool_end` the validated value with the final status. `state_read` is the first consumer-facing trace of `__readState` activity.
- **Typed error codes.** `AgentError.code` is now `AgentErrorCode`: `ABORTED`, `MAX_TURNS`, `ADAPTER_ERROR`, `TRUNCATED`, or `REFUSED`. `ADAPTER_ERROR` carries the HTTP status on `error.status`. `TRUNCATED` reports a model that hit its output token limit and `REFUSED` one that declined to answer; both keep whatever text came back in `message`.
- **`AdapterError`.** Both built-in adapters throw it, with `status` and the raw response `body` on a non-2xx response and neither on a network failure or unparseable body. Its `name` is typed as the literal `'AdapterError'`. Custom adapters can throw it to get the same treatment.
- **`maxStateBytes`.** A per-key size cap on `__readState` results. A value over the cap is replaced with `{ __truncated: true, limit, bytes, preview }` so one oversized key cannot spend the whole context window.
- **`ConversationEntry.error`.** Assistant history entries carry the error their interaction ended with, `ABORTED` included, and an interaction that threw still gets its assistant entry (empty content, empty `toolCalls`, the error set), so history always alternates user, assistant.
- **`TokenUsage` cache fields.** `usage.cacheReadTokens` and `usage.cacheWriteTokens` report the cached part of `promptTokens` when the provider does. `StopReason` is reported on `ModelResponse.stopReason`.
- **Claude adapter:** prompt caching (the system prompt goes out as a `cache_control` text block, which caches tools and system together), `providerData` replay of the raw content blocks so thinking blocks and their signatures survive a round trip, `is_error` on failed tool results, `stop_reason` mapping, cache token usage, and a `cache` flag to turn caching off.
- **OpenAI adapter:** `temperature: null` omits the field for reasoning models that reject one, `finish_reason` mapping, and `prompt_tokens_details.cached_tokens` as `cacheReadTokens`.
- **Unmount aborts interactions.** The provider aborts in-flight and queued interactions when it unmounts, ending them with `ABORTED` exactly as a caller-side cancel would: `onConfirm`'s `signal` fires, handlers see `context.signal` aborted, `onError` is not called, `send()` still settles. A `send()` called through a stale reference after unmount resolves `ABORTED` without calling the model. StrictMode's simulated unmount in development gets a fresh controller and does not affect later sends.
- **`validateToolArgs`** is exported, for custom wiring that wants the same schema-or-parameters check the loop runs.
- **`'use client'` banner** on both bundles, so the package imports from a Next.js App Router tree without a wrapper.
- **CI runs on React 18 and 19**, gates on Prettier and a `tsc` typecheck over `src` (which covers the type-level test files), and checks the packed tarball with publint and arethetypeswrong.

### Changed

- **`send()` calls run one at a time.** Concurrent calls queue in call order, each starting from the transcript the previous one left. The user history entry is appended when the queued call starts executing, so `history` always alternates user, assistant. `isProcessing` is true from the first call until the last queued one settles. Code that disabled its input while `isProcessing` keeps working; code that relied on two sends racing will now see them serialized.
- **`clearHistory()` during an interaction discards that interaction.** When it finishes, nothing it produced lands in `history`, `lastResponse`, or the transcript. Its `send()` still resolves and `onError` still fires.
- **Claude `promptTokens` now includes cached tokens.** Anthropic reports cache reads and writes outside `input_tokens`; `promptTokens` is now the sum of all three, so it means the same thing as OpenAI's `prompt_tokens`. Anyone charting Claude usage will see higher numbers for the same traffic. Prompt caching is on by default; pass `cache: false` to the adapter for the previous plain-string system prompt.
- **Empty assistant messages are dropped from replay.** The loop no longer persists a final assistant message with no content, and both adapters skip one if they meet it in a transcript, since both providers reject it.
- **`AgentError.code` is a union, not `string`.** Code that compared it to a string literal still compiles; code that assigned arbitrary strings to it will not.
- **Tool handlers receive a second argument.** Existing one-argument handlers keep compiling and running; a handler that declares a second parameter gets the `ToolContext`.
- **Reports carry the validated value.** `toolCalls`, `onToolCall`, `tool_end`, and the `onConfirm` prompt all receive the value validation returned rather than the raw model arguments. Without a `schema` the two are identical.
- **An explicit `registerTool` type argument no longer accepts an inline `schema`.** `registerTool<T>(name, handler, { schema })` is now a compile error at the `schema` property, whether or not the schema output agrees with `T`: an explicit type argument turns inference off, which would leave two unchecked sources of truth. Drop the type argument and let the schema supply it. A variable typed as plain `ToolOptions` still passes either way, and inference-driven calls are unchanged.
- **Adapters throw `AdapterError` instead of `Error`.** It is still an `Error`, and messages keep their previous shape, so `catch` blocks that read `message` are unaffected.

## 0.2.0

### Fixed

- **`openAIAdapter` dropped tool calls when replaying assistant messages.** OpenAI rejects any tool-role message that does not follow an assistant message carrying the matching `tool_calls` entry, so every multi-turn tool round trip failed with a 400. Because pull-based state made each state read a tool round trip, this broke most real interactions.
- **Tools missing a `parameters` schema were hidden from the model.** A `description` is now the only requirement for visibility, and a missing `parameters` defaults to the empty object schema. Debug mode warns about tools hidden for lacking a description.
- **A user tool named `__readState` silently shadowed the internal state-reading tool**, leaving its handler unreachable. Tool names beginning with `__` are now rejected on mount.
- **The basic example passed the Zustand hook itself as the state source.** State resolves inside the async agent loop, outside React rendering, so the first state read threw an invalid hook call.
- **`StateSource` and the `tools` prop rejected ordinary usage.** `StateSource` demanded `Record<string, unknown>`, which a typed store interface cannot satisfy without an index signature, and `tools` demanded `ToolDefinition<unknown>[]`, which rejects an array of tools registered with different argument types. Both are widened, so nothing that compiled before stops compiling.

### Added

- **`claudeAdapter`** for the Anthropic Messages API, implemented with raw `fetch` so the package stays dependency free.
- **Abort support.** `send(message, { signal })` cancels an interaction. The signal is checked at each turn, after the model call, and before each tool runs, so cancelling never leaves a tool half-started. Aborts resolve with an `ABORTED` error rather than throwing, and do not reach `onError`.
- **Runtime argument validation.** Tool arguments are checked against the tool's `parameters` schema before execution, and before the confirmation prompt so nobody is asked to approve a malformed call. The validation error is fed back to the model so it can retry.
- **Typed `MAX_TURNS` error.** Exhausting the turn budget while the model is still calling tools now returns `error.code: 'MAX_TURNS'` instead of an empty message.
- **`AgentResponse.usage`**, totalling tokens across every model call in the interaction when the adapter reports them.

### Changed

- **Conversation history is replayed to the model with its structure intact.** Previously prior turns were replayed as plain role and content text, so tool calls and their results were lost between interactions. Aborted turns are dropped rather than replayed, since a cancel can land between an assistant tool call and the result answering it, a shape providers reject.
- Adapters now receive a snapshot of the message list rather than the array the loop keeps appending to.

## 0.1.0

Initial release: tool registry, pull-based state observation via the internal `__readState` tool, permission whitelist enforced at both the visibility and execution layers, confirmation flow, `openAIAdapter`, the agent execution loop, and debug logging.
