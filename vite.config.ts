import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.CRPS_API_PORT ?? 8787}` },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
