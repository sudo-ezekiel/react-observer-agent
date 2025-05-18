import { AIAgentProvider, openAIAdapter } from 'react-observer-agent';
import { useAppStore } from './store';
import { tools } from './tools';
import { ChatPanel } from './ChatPanel';

const model = openAIAdapter({
  apiKey: import.meta.env.VITE_OPENAI_API_KEY as string,
  model: 'gpt-4o',
});

export default function App() {
  const state = useAppStore;

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1>react-observer-agent — Basic Example</h1>
      <p>
        Current page: <strong>{useAppStore((s) => s.currentPage)}</strong> | Cart
        items: <strong>{useAppStore((s) => s.cart.length)}</strong>
      </p>

      <AIAgentProvider
        model={model}
        state={state}
        tools={tools}
        permissions={{
          canAccess: ['user', 'currentPage', 'cart', 'products'],
          canExecute: ['navigateTo', 'addToCart', 'clearCart'],
        }}
        options={{
          debug: true,
          systemPrompt:
            'You are a helpful shopping assistant. You can navigate the app, add products to the cart, and clear the cart. The available products are visible in the app state.',
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
