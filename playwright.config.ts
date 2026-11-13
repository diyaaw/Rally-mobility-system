import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 90000,
  retries: 0,
  workers: 1, // sequential – shared state across tests
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  reporter: [['list'], ['json', { outputFile: 'test-results.json' }]],
  // Use the root tsconfig for tests (not the Next.js one)
});
