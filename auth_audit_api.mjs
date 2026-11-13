/**
 * RALLY Auth Audit — API /auth/me verification
 * Logs in, then calls GET /api/v1/auth/me with the real token.
 */
import { chromium } from 'playwright';

const EMAIL = 'testuser_a@rally.test';
const PASSWORD = 'RallyTest@2024!';
const BASE_URL = 'http://localhost:3000';
const API_BASE = 'http://localhost:8000';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Block settings to prevent redirect loop
  await page.route('**/api/v1/settings**', r => r.abort());

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 20000 });
  console.log('Logged in. URL:', page.url());

  // Get token from localStorage
  const lsKey = await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.includes('auth-token')) return k;
    }
    return null;
  });
  console.log('localStorage key:', lsKey);

  const tokenData = await page.evaluate((key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }, lsKey);

  if (!tokenData?.access_token) {
    console.log('ERROR: no access_token found');
    await browser.close();
    return;
  }

  const token = tokenData.access_token;
  console.log('Token alg header:', JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString()).alg);
  console.log('Token exp:', new Date(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000).toISOString());
  console.log('Token sub (first 8 chars):', JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub?.substring(0, 8) + '...');

  // Test GET /auth/me using the page context (same origin, can reach localhost:8000)
  const meResp = await page.evaluate(async ({ apiBase, tok }) => {
    try {
      const r = await fetch(`${apiBase}/api/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${tok}`, 'Accept': 'application/json' }
      });
      const text = await r.text();
      return { status: r.status, body: text };
    } catch (e) {
      return { error: e.message };
    }
  }, { apiBase: API_BASE, tok: token });

  console.log('\nGET /api/v1/auth/me response:');
  console.log('  Status:', meResp.status || 'ERROR');
  if (meResp.error) {
    console.log('  Error:', meResp.error);
  } else {
    try {
      const body = JSON.parse(meResp.body);
      // Mask actual UUID (show only first 8 chars)
      const maskedId = body.id ? body.id.substring(0, 8) + '...[UUID]' : '(none)';
      console.log('  id present:', body.id ? `YES (${maskedId})` : 'NO');
      console.log('  email:', body.email === EMAIL ? 'MATCH' : `VALUE=${body.email}`);
      console.log('  profile:', JSON.stringify(body.profile));
    } catch {
      console.log('  Raw body:', meResp.body?.substring(0, 200));
    }
  }

  // Test with a deliberately invalid token
  const badResp = await page.evaluate(async ({ apiBase }) => {
    const r = await fetch(`${apiBase}/api/v1/auth/me`, {
      headers: { 'Authorization': 'Bearer notavalidtoken', 'Accept': 'application/json' }
    });
    return { status: r.status };
  }, { apiBase: API_BASE });
  console.log('\nGET /api/v1/auth/me with BAD token:', badResp.status, badResp.status === 401 ? '(PASS)' : '(FAIL)');

  // Test with no token
  const noTokenResp = await page.evaluate(async ({ apiBase }) => {
    const r = await fetch(`${apiBase}/api/v1/auth/me`, { headers: { 'Accept': 'application/json' } });
    return { status: r.status };
  }, { apiBase: API_BASE });
  console.log('GET /api/v1/auth/me with NO token:', noTokenResp.status, noTokenResp.status === 401 ? '(PASS)' : '(FAIL)');

  // Check sub claim ID matches what localStorage reports
  const lsUserId = tokenData.user?.id;
  const jwtSub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  console.log('\nSub claim consistency:');
  console.log('  JWT sub === localStorage user.id:', jwtSub === lsUserId ? 'MATCH (PASS)' : 'MISMATCH (FAIL)');

  await browser.close();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

