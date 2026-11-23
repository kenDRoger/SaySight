import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The dev server is reached over Tailscale by name, so the host check must accept the
  // tailnet domain; Vite otherwise answers 403 "Blocked request".
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.ts.net', 'localhost', '127.0.0.1'],
    proxy: { '/api': process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
