![ShowCase](https://github.com/user-attachments/assets/84c38dc6-7f62-4c37-8d96-3b3eac489140)

# react-observer-agent


`react-observer-agent` is an **experimental project** by a solo developer exploring whether it's possible to build an AI agent system that:

- Observes a live React app’s state and UI
- Understands what the user is doing and what actions are possible
- Uses large language models (LLMs) to suggest or execute actions, safely
- Does all of this through a simple `<Provider>` and registered tools

My vision is to be able to use it like this:

```tsx
import { AIAgentProvider, registerTool, openAIAdapter, useAgent } from 'react-observer-agent';
import { useStore } from './store';

// 1. Register tools — actions the agent can perform
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
  baseURL: '/api/agent',  // your backend proxy holds the real API key
});

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
  // send("What's in my cart?") → agent reads state, responds with text
  // send("Go to settings")     → agent calls goToPage({ path: '/settings' })
}
```

The `state` prop works with **any state manager** — pass a getter function for Zustand/Redux, or a plain object for vanilla React state:

```tsx
// Vanilla React — just pass an object
<AIAgentProvider state={{ user, cart }} ... >
```

This is a personal research initiative — not a commercial product.

---

## 🎯 Why I'm Building It

Most "AI integrations" in frontend apps today are:
- Shallow (just chats or autocomplete)
- Stateless (no awareness of what’s on the page or in the app)
- Unsafe (not designed to act in complex UIs)

I'm interested in pushing this further — to see if an AI can:
- Understand app structure and user state
- Safely invoke pre-defined actions
- Integrate flexibly with tools like Zustand, Redux, and OpenAI
- Respect privacy and permission boundaries

---

## 🧪 What I Want to Learn

- Can an AI agent understand enough about a live React app to be useful?
- Can state and action exposure be automated with zero glue code?
- Can I support multiple LLM backends (OpenAI, Claude, local) through adapters?
- Can this be done safely, privately, and scalably?

---

## 🛣️ Roadmap (Experimental Goals)

- 🔜 Manual state observation + tool registry + OpenAI support
- 🔜 DOM awareness + page context mapping
- 🔜 Consent model + permission boundaries
- 🔜 Model adapter layer (Claude, Ollama, etc.)
- 🔜 In-memory agent "short-term memory"
- 🔜 Developer-friendly logging & test tools

---

## ⚠️ Disclaimer

This is a solo experiment.  
It is **not production-ready**.  
It may change, break, or stop at any time.

If you're at a company curious about intelligent UIs, you're welcome to explore it, fork it, or reach out. Feedback is appreciated.

---
