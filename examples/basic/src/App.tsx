import { AIAgentProvider, claudeAdapter, openAIAdapter } from 'react-observer-agent';
import { useAppStore } from './store';
import { tools } from './tools';
import { ChatPanel } from './ChatPanel';

// Set VITE_PROVIDER=claude to run the same example against the Anthropic API.
const provider = import.meta.env.VITE_PROVIDER === 'claude' ? 'claude' : 'openai';

// Both point at the dev server's /api proxy, which holds the key. See
// vite.config.ts, and section 3.4 of the spec for the production pattern.
const model =
  provider === 'claude'
    ? claudeAdapter({ baseURL: '/api/anthropic' })
    : openAIAdapter({ baseURL: '/api/openai' });

// Resolved inside the agent loop, outside React rendering, so this reads the
// store through its vanilla API rather than calling the hook.
const getAppState = () => useAppStore.getState();

export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>react-observer-agent: basic example</h1>
      <p>
        Current page: <strong>{useAppStore((s) => s.currentPage)}</strong> | Cart
        items: <strong>{useAppStore((s) => s.cart.length)}</strong> | Provider:{' '}
        <strong>{provider}</strong>
      </p>

      <AIAgentProvider
        model={model}
        state={getAppState}
        tools={tools}
        permissions={{
          canAccess: ['user', 'currentPage', 'cart', 'products'],
          canExecute: ['navigateTo', 'addToCart', 'clearCart'],
          stateDescriptions: {
            user: 'Current logged-in user profile (name, email)',
            currentPage: 'The page the user is currently viewing',
            cart: 'Shopping cart items and quantities',
            products: 'Available product catalog with IDs, names, and prices',
          },
        }}
        options={{
          debug: true,
          systemPrompt:
            'You are a helpful shopping assistant. You can navigate the app, add products to the cart, and clear the cart. Use readState to check available products before answering questions.',
          onConfirm: async (pending) => {
            return window.confirm(
              `Allow "${pending.toolName}" with args ${JSON.stringify(pending.args)}?`,
            );
          },
        }}
      >
        <ChatPanel />
      </AIAgentProvider>
    </div>
  );
}
