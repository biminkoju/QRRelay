import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
  },
  webServer: [
    {
      command: 'npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      // Same files, served under a subpath the way GitHub Pages serves a
      // project site. Proves the build is not secretly origin-root-bound.
      command: 'npm run serve:prefix',
      url: 'http://localhost:4175/qrrelay/',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
