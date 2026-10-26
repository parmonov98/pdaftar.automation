import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      '/api': 'http://127.0.0.1:8095',
      '/media': 'http://127.0.0.1:8095',
      '/auth': 'http://127.0.0.1:8095',
    },
  },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx', 'src/**/*.test.ts'] },
} as never);
