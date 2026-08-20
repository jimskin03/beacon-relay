import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:3000',
    headless: true,
  },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3000/healthz',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
