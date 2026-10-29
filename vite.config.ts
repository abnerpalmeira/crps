import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.CRPS_API_PORT ?? 8787}` },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
  // Os addons do three entram no mesmo pré-empacotamento: descobertos depois, viram uma segunda cópia do three.
  optimizeDeps: {
    include: [
      'three',
      'three/addons/controls/OrbitControls.js',
      'three/addons/renderers/CSS2DRenderer.js',
      'three/addons/loaders/GLTFLoader.js',
      'three/addons/utils/SkeletonUtils.js',
    ],
  },
});
