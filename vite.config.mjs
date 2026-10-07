import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5184,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4184',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request, incoming) => {
            if (
              ['http://127.0.0.1:5184', 'http://localhost:5184'].includes(incoming.headers.origin)
            ) {
              request.setHeader('origin', 'http://127.0.0.1:4184');
            }
          });
        },
      },
    },
  },
});
