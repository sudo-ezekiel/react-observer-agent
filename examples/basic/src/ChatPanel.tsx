import { useState, type FormEvent } from 'react';
import { useAgent } from 'react-observer-agent';

export function ChatPanel() {
  const { send, history, isProcessing } = useAgent();
  const [input, setInput] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const message = input.trim();
    if (!message || isProcessing) return;
    setInput('');
    void send(message);
  };

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', fontFamily: 'system-ui, sans-serif' }}>
      <h2>Chat</h2>

      <div
        style={{
          border: '1px solid #ccc',
          borderRadius: 8,
          padding: 16,
          height: 400,
          overflowY: 'auto',
          marginBottom: 12,
          background: '#fafafa',
        }}
      >
        {history.map((entry, i) => (
          <div
            key={i}
            style={{
              marginBottom: 8,
              textAlign: entry.role === 'user' ? 'right' : 'left',
            }}
          >
            <span
              style={{
                display: 'inline-block',
                padding: '8px 12px',
                borderRadius: 12,
                background: entry.role === 'user' ? '#0071e3' : '#e5e5ea',
                color: entry.role === 'user' ? '#fff' : '#000',
                maxWidth: '80%',
                wordBreak: 'break-word',
              }}
            >
              {entry.content}
            </span>
          </div>
        ))}
        {isProcessing && (
          <div style={{ color: '#999', fontStyle: 'italic' }}>Thinking…</div>
        )}
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask the agent something…"
          disabled={isProcessing}
          style={{
            flex: 1,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #ccc',
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={isProcessing || !input.trim()}
          style={{
            padding: '8px 16px',
            borderRadius: 8,
            border: 'none',
            background: '#0071e3',
            color: '#fff',
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}
