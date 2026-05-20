import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: [
      '@found-in-space/meta-sidecar-provider',
      '@found-in-space/star-octree-provider',
      '@found-in-space/star-trees',
    ],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
});
