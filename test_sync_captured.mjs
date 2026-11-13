import { chromium } from 'playwright';

const BASE_URL = 'http://localhost:3000';
const EMAIL = 'testuser_a@rally.test';
const PASSWORD = 'RallyTest@2024!';

async function verifySyncExecution() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  let settingsRequest = null;

  page.on('request', req => {
    if (req.url().includes('/api/v1/settings')) {
      settingsRequest = {
        url: req.url(),
        method: req.method(),
        authHeader: req.headers()['authorization'] ? 'Bearer [PRESENT]' : 'MISSING'
      };
    }
  });

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'load' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/dashboard/, { timeout: 15000 });
  await page.waitForTimeout(2000);

  console.log('Settings request captured upon authentication:', JSON.stringify(settingsRequest));

  await browser.close();
}

verifySyncExecution().catch(console.error);

