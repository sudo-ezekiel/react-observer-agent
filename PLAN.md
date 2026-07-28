# react-observer-agent v0.2.0 Implementation Plan

> Executor: Claude Opus 5
> Prepared: July 28, 2026, against commit 0589e23 plus the rewritten SPEC.md
> Normative reference: [SPEC.md](SPEC.md) version 0.2.0. This plan brings the code into conformance with it and ships the v0.2 roadmap.

---

## 0. Context

`react-observer-agent` is a zero-runtime-dependency React library. An `AIAgentProvider` wires app state, registered tools, an LLM adapter, and a permission whitelist together; `useAgent()` exposes `send()`. State is pull-based: the LLM sees a manifest of key names and reads values on demand through an internal `__readState` tool. Read SPEC.md in full before starting; skim [docs/internals.md](docs/internals.md) for the rationale behind the pull model.

SPEC.md section 7 lists four confirmed divergences between spec and code. Divergence 1 (the OpenAI adapter drops `tool_calls` when replaying assistant messages) breaks every multi-turn tool round trip against the real OpenAI API, and since the `__readState` refactor made every state read a tool round trip, it breaks most real interactions. That fix comes first.

### Verified baseline (do not skip re-verifying)

As of July 28, 2026: `npm run build` succeeds, `npm run lint` is clean, `npm run test` passes 10 files / 90 tests. `node_modules` is installed. One provider test prints a React error-boundary warning to the console; that is expected noise from a throw-on-mount test, not a failure. Re-run all three commands before Phase 1 and stop if anything is red.

### Ground rules

1. **No em dashes.** The em dash character (Unicode U+2014) must not appear in anything you produce: code, comments, tests, docs, commit messages, chat replies. Use commas, colons, parentheses, or reword. Hyphens and en dashes for ranges are fine. Existing em dashes in files you touch may stay unless you are rewriting that line anyway. Scan every file you write with a grep for the character before committing.
2. **Zero runtime dependencies.** Do not add packages to `dependencies`. Adapters use raw `fetch`. The argument validator in Phase 6 is hand-written, not ajv.
3. **Strict TypeScript, existing style.** Two-space indent, single quotes, trailing commas, `type` imports, per the existing Prettier and ESLint config. Match the code around you.
4. **Every phase ends green.** Run `npm run build && npm run lint && npm run test` before each commit. Never commit with any of the three failing.
5. **One commit per phase**, using the exact message given. Do not squash phases together.
6. **Stay in scope.** No drive-by refactors, no extra features, nothing from the "Out of scope" list. If a phase's stated assumption about the code turns out false, stop and report instead of improvising around it.
7. **Public API changes are additive only.** Nothing in the current exported surface may break; new fields and optional parameters only.

### Phase ordering constraints

Run phases in the order given. Hard dependencies: Phase 8 (structured replay) requires Phase 1 (OpenAI rejects replayed tool results unless the assistant message carries matching `tool_calls`). Phase 9's tests reuse patterns from Phase 1's tests. Phase 11 documents everything and must be last.

---

## Phase 1: Fix openAIAdapter assistant tool_calls serialization (critical)

**Problem.** `formatMessage` in [src/adapters/openai.ts](src/adapters/openai.ts) (around line 102) serializes only `role`, `content`, `toolCallId`. It ignores the `toolCalls` field that `executeAgentLoop` sets on assistant messages. OpenAI requires any `role: "tool"` message to follow an assistant message whose `tool_calls` array contains the matching id; without it the API returns 400 ("messages with role 'tool' must be a response to a preceding message with 'tool_calls'").

**Changes** in `src/adapters/openai.ts`:

- Change `formatMessage` to accept the full `ConversationMessage` type (import it as a type from `../types`).
- When `msg.toolCalls` is present and non-empty, emit OpenAI-format `tool_calls`:
  ```ts
  tool_calls: msg.toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function' as const,
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
    },
  }))
  ```
  Note `function.arguments` must be a JSON **string**; the internal `LLMToolCall.arguments` is already parsed, so re-stringify.
- For assistant messages that carry `toolCalls` and have an empty-string `content`, emit `content: null` (OpenAI convention).

**Tests** in `src/adapters/openai.test.ts` (Vitest, mocked `fetch`, matching the existing test style):

- An assistant `ConversationMessage` with `toolCalls` followed by a `role: 'tool'` message with `toolCallId` produces a request body where the assistant entry has `tool_calls` with `type: 'function'` and stringified `arguments`, and the tool entry has the matching `tool_call_id`.
- An assistant message with `toolCalls` and empty content serializes with `content: null`.
- Plain user and assistant messages without `toolCalls` are unchanged (no `tool_calls` key).

**Commit:** `fix: serialize assistant tool_calls in openAIAdapter messages`

---

## Phase 2: Tool visibility defaults

**Problem.** [executeAgentLoop.ts:88](src/provider/executeAgentLoop.ts:88) filters the LLM tool list with `.filter((t) => t.description && t.parameters)`, silently dropping any tool missing either field. SPEC.md 3.1 says: `description` is required for LLM exposure; missing `parameters` defaults to the empty object schema.

**Changes** in `src/provider/executeAgentLoop.ts`:

- Filter on `t.description` only.
- Map `parameters: t.parameters ?? { type: 'object', properties: {} }`.
- When a tool in `allowedTools` lacks a `description` and `debug` is true, `console.warn` with the `[react-observer-agent]` prefix that the tool is hidden from the LLM for lacking a description.

**Tests** in `src/provider/executeAgentLoop.test.ts` (mock `ModelAdapter` that records the request, as the existing tests do):

- A tool with description but no parameters appears in the request's tool list with the empty object schema.
- A tool with no description is absent from the request's tool list, and a debug warning fires (spy on `console.warn`).
- Such a tool is still executable if the LLM names it (it remains in the tool map), since `canExecute` is the authority.

**Commit:** `fix: expose described tools without parameters via empty object schema`

---

## Phase 3: Reserved `__` name prefix

**Problem.** A user tool named `__readState` is shadowed by the internal tool; its handler is unreachable. SPEC.md 3.1 reserves the `__` prefix.

**Changes** in `src/tools/validateToolNames.ts`: before the duplicate check, throw when a name starts with `__`:

```
Tool name "<name>" uses the reserved "__" prefix. Names beginning with "__" are reserved for internal tools.
```

The provider already calls `validateToolNames` on mount, so no provider change is needed.

**Tests** in `src/tools/validateToolNames.test.ts`: `__readState` and `__anything` throw; a name with a single underscore or internal double underscore (`my__tool`) passes.

**Commit:** `feat: reject reserved __ tool name prefix`

---

## Phase 4: Fix example app state source

**Problem.** [examples/basic/src/App.tsx:12](examples/basic/src/App.tsx:12) does `const state = useAppStore;` and passes the Zustand hook itself as `state`. The library resolves state inside the async loop (outside React rendering), so calling the hook there throws React's invalid hook call error on the first `__readState`.

**Changes** in `examples/basic/src/App.tsx`: replace the hook-as-getter with

```tsx
state={() => useAppStore.getState()}
```

(and delete the now-unused `const state = useAppStore;` line). `permissions.canAccess` already filters the keys, so returning the full store state is fine.

**Verification:** `cd examples/basic && npx tsc --noEmit` passes (run `npm install` there first if `node_modules` is missing). The root suite is unaffected but run it anyway per ground rule 4.

**Commit:** `fix: example app resolves zustand state via getState`

---

## Phase 5: Typed MAX_TURNS error

**Problem.** When `maxTurns` is exhausted while the model is still calling tools, the loop returns `{ message: '', toolCalls }` with no error. Consumers cannot distinguish "agent had nothing to say" from "loop was cut off".

**Changes:**

- `src/provider/executeAgentLoop.ts`: track whether the loop exited via the text-only break. On exhaustion without a final message, return the accumulated `toolCalls` plus:
  ```ts
  error: {
    message: `Agent did not produce a final response within ${maxTurns} turns`,
    code: 'MAX_TURNS',
  }
  ```
  Keep the existing debug warning.
- `src/provider/AIAgentProvider.tsx`: after a successful (non-thrown) `executeAgentLoop`, if `response.error` is set, invoke `optionsRef.current?.onError?.(response.error)`. The catch path already calls `onError`; make sure no path calls it twice for one send.

**Tests:**

- Loop test: a mock model that always returns tool calls yields `error.code === 'MAX_TURNS'`, an empty `message`, and the accumulated `toolCalls`.
- Provider test: same mock model through `send()`; `onError` is called exactly once and `lastResponse.error.code` is `'MAX_TURNS'`.

**Commit:** `feat: typed MAX_TURNS error on turn exhaustion`

---

## Phase 6: Runtime argument validation

**Problem.** `parameters` schemas are advisory today; handlers receive whatever the LLM sent. SPEC.md's roadmap item 4 adds validation before execution.

**Changes:**

- New file `src/tools/validateArgs.ts` exporting `validateArgs(args: unknown, schema: JSONSchema): { valid: boolean; errors: string[] }`. Implement a deliberate **subset** of JSON Schema: `type` (`object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties` (recursive), `required`, `items`, `enum`. Ignore everything else (no `additionalProperties` enforcement, no `$ref`, no `allOf`/`oneOf`, no formats, no numeric or length constraints). Unknown keywords are silently ignored so real-world schemas do not false-fail. Keep it under ~120 lines. Do not export it from `src/index.ts`; it is internal.
- `src/provider/executeAgentLoop.ts`: after the `toolMap` lookup succeeds and **before** the confirmation flow (users should not be asked to approve malformed calls), when `toolDef.parameters` is set, run `validateArgs`. On failure: status `'error'`, result `Invalid arguments for tool "<name>": <errors joined with '; '>`, pushed to `allToolCalls`, fired through `onToolCall`, and fed back to the LLM as `{ error: ... }` so it can retry with corrected arguments. The handler is not called. Tools without a user-supplied `parameters` schema are not validated.

**Tests:**

- Unit tests for `validateArgs` in `src/tools/validateArgs.test.ts`: type mismatches, missing required, nested properties, array items, enum, unknown keywords ignored, non-object args against an object schema.
- Loop integration test: model calls a tool with a missing required property; handler is not invoked (spy), result status is `'error'`, LLM receives the error payload, `onConfirm` is never called for that attempt.

**Commit:** `feat: validate tool arguments against parameters schema`

---

## Phase 7: Abort support

**Goal.** `send(message, { signal })` cancels an in-flight interaction. SPEC.md roadmap item 5.

**Changes:**

- `src/types.ts`: add `export interface SendOptions { signal?: AbortSignal }`. Change `AgentContext.send` to `(message: string, options?: SendOptions) => Promise<AgentResponse>`. Add `signal?: AbortSignal` to `ModelRequest`. Export `SendOptions` from `src/index.ts`.
- `src/provider/executeAgentLoop.ts`: accept `signal` in the execution context and put it on each `ModelRequest`. Checkpoints: at the top of each turn, after the model response, and before each tool execution, check `signal?.aborted`; if aborted, return immediately with accumulated `toolCalls` and `error: { message: 'Interaction aborted', code: 'ABORTED' }`. Wrap `model.sendMessage` in try/catch: when the thrown error has `name === 'AbortError'` (or the signal is aborted), return the same ABORTED response instead of rethrowing.
- `src/adapters/openai.ts` (and `claude.ts` in Phase 9): pass `request.signal` to `fetch` as `signal`.
- `src/provider/AIAgentProvider.tsx`: thread `options?.signal` through to the loop. Do **not** call `onError` when `response.error?.code === 'ABORTED'`; a user-initiated cancel is not an app error. (This refines the Phase 5 rule: fire `onError` for a returned error unless its code is `'ABORTED'`.)

**Tests:**

- Loop: an already-aborted signal returns `code: 'ABORTED'` without calling the adapter.
- Loop: a mock adapter that rejects with an `AbortError`-named error yields `code: 'ABORTED'`, not a thrown failure.
- Adapter: mocked `fetch` receives the `signal` option.
- Provider: `onError` is not called for an aborted send; `isProcessing` returns to false.

**Commit:** `feat: abort support via send(message, { signal })`

---

## Phase 8: Structured history replay

**Problem.** The provider replays prior history to the LLM as plain role plus content text, so structured tool calls (including `__readState` reads) are lost between `send()` calls. SPEC.md roadmap item 7. Requires Phase 1.

**Changes:**

- `src/provider/executeAgentLoop.ts`: change the return type to `{ response: AgentResponse; messages: ConversationMessage[] }` where `messages` is the full LLM-facing message list including this turn. This function is package-internal (not exported from `src/index.ts`), so the signature change is safe; update its callers and tests.
- `src/provider/AIAgentProvider.tsx`: keep a `transcriptRef = useRef<ConversationMessage[]>([])`. `send()` passes `transcriptRef.current` as `conversationHistory` (replacing the text-only mapping of `historyRef`). On a successful, non-thrown completion, set `transcriptRef.current = result.messages`. On a thrown error, leave the transcript unchanged (drop the partial turn). `clearHistory()` also resets the transcript. The user-facing `history` state is unchanged.

**Accepted trade-offs** (note them in the Phase 11 docs, do not engineer around them): replayed `__readState` results carry values that may be stale (the manifest instruction already tells the model to re-read when needed), and the transcript grows with each interaction (`maxTurns` bounds per-send growth; `clearHistory` is the reset).

**Tests** (provider-level, mock adapter that records every request):

- Two sequential `send()` calls: the second request's `messages` include the first turn's assistant message with intact `toolCalls` and the tool result messages with `toolCallId`.
- `clearHistory()` between sends resets the replayed messages to just the new user message.
- A send whose adapter throws does not pollute the transcript for the next send.

**Commit:** `feat: structured conversation replay across send calls`

---

## Phase 9: claudeAdapter (Anthropic Messages API)

**Goal.** Ship `claudeAdapter` mirroring `openAIAdapter`'s structure: raw `fetch`, no SDK dependency (the library is zero-dependency and the production path routes through a `baseURL` proxy anyway).

**API facts** (verified against Anthropic docs, July 2026; do not substitute recalled variants):

- Endpoint: `POST {base}/v1/messages`. Default base `https://api.anthropic.com`. If a configured `baseURL` already contains `/v1/messages`, use it as is; otherwise append `/v1/messages`.
- Headers: `content-type: application/json`; `anthropic-version: 2023-06-01`; `x-api-key: <key>` when `apiKey` is set. When calling directly from a browser with `apiKey`, Anthropic requires an explicit CORS opt-in header: `anthropic-dangerous-direct-browser-access: true`. Send it whenever `apiKey` is set. Verify the exact header name against the current Anthropic CORS docs with one WebFetch before writing the code; if it has changed, use the documented name. Spread `config.headers` last so consumers can override.
- Body: `model`, `max_tokens` (required), optional top-level `system` string, `messages`, optional `tools`. Do **not** send `temperature`, `top_p`, or `thinking`: `claude-opus-5` rejects sampling parameters with a 400, and thinking is on by default when the parameter is omitted.
- Tool definitions: `{ name, description, input_schema }` (`input_schema`, not `parameters`).
- Assistant messages with tool calls: `content` is an array of blocks, text block first when non-empty, then one `{ type: 'tool_use', id, name, input }` per call, where `input` is the parsed arguments object (when `arguments` is not an object, substitute `{}`).
- Tool results: a **user** message whose content is `[{ type: 'tool_result', tool_use_id, content: <string> }]`. Merge each consecutive run of internal `role: 'tool'` messages into a single user message with multiple `tool_result` blocks.
- Response: `data.content` is an array of blocks. Concatenate `text` blocks for `content` (null when there are none and tool calls exist); map `tool_use` blocks to `LLMToolCall` as `{ id, name, arguments: block.input }` (already an object, no JSON parsing). Ignore other block types (for example `thinking`). Map `data.usage.input_tokens` and `output_tokens` to `promptTokens` and `completionTokens`. A `stop_reason` of `"refusal"` still returns 200; the block mapping above handles it naturally (empty content).
- Errors: mirror `openai.ts` exactly (network throw, non-2xx throw with status and body text, JSON parse throw).

**Changes:**

- `src/types.ts`: `export interface ClaudeAdapterConfig { apiKey?: string; model?: string; baseURL?: string; maxTokens?: number; headers?: Record<string, string> }`.
- New `src/adapters/claude.ts`: `export function claudeAdapter(config: ClaudeAdapterConfig): ModelAdapter`. Defaults: model `claude-opus-5`, maxTokens `16000`. Throw at construction when neither `apiKey` nor `baseURL` is provided, with the same wording pattern as `openAIAdapter`. Pass `request.signal` to `fetch` (Phase 7).
- Export `claudeAdapter` from `src/adapters/index.ts` and `src/index.ts`; export the `ClaudeAdapterConfig` type.

**Tests** in `src/adapters/claude.test.ts` (mocked `fetch`, mirroring `openai.test.ts`):

- Throws without `apiKey` and `baseURL`.
- Request shape: headers (`x-api-key`, `anthropic-version`, browser CORS header present with `apiKey`; `x-api-key` absent when only `baseURL`), `system` passed top-level, `max_tokens` present, no `temperature` key.
- Assistant message with `toolCalls` becomes text plus `tool_use` blocks; two consecutive tool messages merge into one user message with two `tool_result` blocks.
- Parses a text response; parses a `tool_use` response into `toolCalls` with object `arguments`; maps `usage`.
- Non-2xx and malformed JSON throw.

**Commit:** `feat: claudeAdapter for the Anthropic Messages API`

---

## Phase 10: Usage aggregation

**Goal.** Surface per-interaction token usage (SPEC.md roadmap item 9).

**Changes:**

- `src/types.ts`: add `usage?: { promptTokens: number; completionTokens: number }` to `AgentResponse`.
- `src/provider/executeAgentLoop.ts`: sum `modelResponse.usage` across turns; include the total in the returned response only when at least one turn reported usage.

**Tests:** loop test with a mock adapter reporting usage on two turns asserts the sums; a mock without usage yields `usage: undefined`.

**Commit:** `feat: aggregate token usage per interaction`

---

## Phase 11: Documentation sync, changelog, version bump

All code phases are done; make the documents true again. No em dashes in any edited or new line.

- **SPEC.md:** update the header (`Last updated`, Status line now "Describes the library as implemented at v0.2.0"). Replace the section 7 divergence table with a note that all four divergences were fixed in v0.2.0 (keep the section as a placeholder for future divergences). Update: 3.1 (visibility rule and reserved prefix now enforced; arguments are validated, drop the "advisory in v0.1.0" wording), 3.3 (`send` signature with `SendOptions`; structured replay semantics replace the text-only replay paragraph; `AgentResponse.usage`), 3.4 (adapter table: `claudeAdapter` shipped; remove the "known bug" note; add `ClaudeAdapterConfig` and its security note mirroring the OpenAI one; add `signal` to `ModelRequest`), 4.1 (loop pseudo gains the validation step, abort checkpoints, and the MAX_TURNS error return), section 6 exports (add `claudeAdapter`, `SendOptions`, `ClaudeAdapterConfig`), section 8 (move completed roadmap items to Done; remaining: ollamaAdapter, streaming, and anything you did not ship).
- **docs/internals.md:** update the execution-loop pseudocode and debug-logging list for the same changes; add a short "Structured replay" paragraph covering the transcript ref and the stale-readState trade-off from Phase 8.
- **README.md:** add a `claudeAdapter` snippet next to the OpenAI one and a one-line mention of `send(message, { signal })`. Keep edits minimal; the README is intentionally informal.
- **CHANGELOG.md (new):** a `## 0.2.0` section listing the phases in user-facing terms (fixed, added, changed).
- **package.json:** version `0.2.0`.
- Full verification pass (below), then commit.

**Commit:** `chore: release v0.2.0 (docs, changelog, version bump)`

---

## Verification

After every phase, and once more at the end:

```bash
npm run build
```

```bash
npm run lint
```

```bash
npm run test
```

After Phase 4 additionally:

```bash
cd examples/basic && npx tsc --noEmit
```

Optional live smoke test (requires a real key; skip in CI): `examples/basic` with `VITE_OPENAI_API_KEY` set, ask "What's in my cart?", confirm a `__readState` round trip completes with `debug: true` console output and no 400 from the API. This exercises Phase 1 end to end.

## Out of scope for v0.2.0

Streaming responses, `ollamaAdapter`, DOM awareness, persistent memory, multi-agent orchestration, built-in rate limiting, full JSON Schema validation (ajv or similar), and any change to the pull-based state architecture. If work in a phase seems to require one of these, stop and report.
