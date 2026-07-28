# Changelog

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
