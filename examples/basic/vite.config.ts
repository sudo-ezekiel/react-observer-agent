import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dev server stands in for the backend proxy the library recommends for
 * production. The browser calls a same-origin /api path and the key is attached
 * here, on the Node side, so it never reaches the bundle. Being same-origin also
 * means no CORS negotiation with either provider.
 *
 * Keys are read without the VITE_ prefix on purpose: a VITE_ variable would be
 * inlined into client code and shipped to the browser.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api/openai': {
          target: 'https://api.openai.com/v1',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/openai/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.OPENAI_API_KEY) {
                proxyReq.setHeader('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
              }
            });
          },
        },
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (env.ANTHROPIC_API_KEY) {
                proxyReq.setHeader('x-api-key', env.ANTHROPIC_API_KEY);
              }
            });
          },
        },
      },
    },
  };
});
