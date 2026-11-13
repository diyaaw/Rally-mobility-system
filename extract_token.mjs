/**
 * Extract token from browser session and save to a temp file for JWT check.
 * Masks token in output — only saves it to file.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const EMAIL = 'testuser_a@rally.test';
const PASSWORD = 'RallyTest@2024!';
const BASE_URL = 'http://localhost:3000';
const TOKEN_FILE = 'C:/test_evidence/token_for_check.tmp';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/api/v1/settings**', r => r.abort());

  await page.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });

  const lsKey = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.includes('auth-token')) return k;
    }
    return null;
  });

  const tokenData = await page.evaluate((key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }, lsKey);

  if (tokenData?.access_token) {
    fs.writeFileSync(TOKEN_FILE, tokenData.access_token);
    const tok = tokenData.access_token;
    console.log(`Token saved. Length: ${tok.length}. Alg: ${JSON.parse(Buffer.from(tok.split('.')[0], 'base64url').toString()).alg}`);
  } else {
    console.log('ERROR: no token found');
  }

  await browser.close();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

