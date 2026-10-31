import { defineConfig } from 'vitest/config';
import { cspPlugin } from './build/csp';
import { singleFilePlugin } from './build/single-file';
import { pwaPlugin } from './build/pwa';

export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const buildId = process.env.BUILD_ID ?? new Date().toISOString();
  return {
    base: './',
    define: {
      'import.meta.env.VITE_BUILD_ID': JSON.stringify(buildId),
      'import.meta.env.VITE_BUILD_KIND': JSON.stringify(single ? 'single' : 'pwa'),
    },
    build: {
      outDir: single ? 'dist-single' : 'dist',
      target: 'es2022',
      sourcemap: false,
      cssCodeSplit: !single,
      assetsInlineLimit: single ? 100000000 : 4096,
    },
    plugins: [cspPlugin(), single ? singleFilePlugin() : pwaPlugin(buildId)],
    test: {
      include: ['tests/**/*.test.ts'],
      environment: 'node',
    },
  };
});
