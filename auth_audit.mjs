/**
 * RALLY Phase 1 Auth Audit — Playwright live verification
 * READ-ONLY: no code/config changes.
 * Run: node auth_audit.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const EMAIL = 'testuser_a@rally.test';
const PASSWORD = 'RallyTest@2024!';
const BASE_URL = 'http://localhost:3000';
const API_URL  = 'http://localhost:8000/api/v1';
const EVIDENCE_DIR = 'C:/test_evidence';

fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

function safe(val) {
  if (!val) return '(none)';
  if (val.length > 40) return val.slice(0, 20) + '...[REDACTED]...' + val.slice(-8);
  return val;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = {};

  // ── STEP 2A: Login ──────────────────────────────────────────────────────────
  console.log('\n[STEP 2A] Login verification');
  try {
    // Intercept settings to prevent redirect loop
    await page.route('**/api/v1/settings', route => route.abort());

    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH01_login_page.png` });

    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);

    // Capture the Supabase auth network response
    let supabaseResponse = null;
    page.on('response', async resp => {
      if (resp.url().includes('/auth/v1/token')) {
        try { supabaseResponse = await resp.json(); } catch {}
      }
    });

    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 15000 });
      results.login_redirect = 'PASS — redirected to /dashboard';
    } catch (e) {
      results.login_redirect = `FAIL — URL after submit: ${page.url()}`;
    }

    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH02_after_login.png` });

    // Extract access token from localStorage
    const lsKey = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.includes('auth-token')) return k;
      }
      return null;
    });
    results.ls_key = lsKey ? `FOUND: ${lsKey}` : 'NOT FOUND';

    const tokenData = await page.evaluate((key) => {
      if (!key) return null;
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    }, lsKey);

    if (tokenData && tokenData.access_token) {
      const tok = tokenData.access_token;
      results.access_token = `PRESENT (length=${tok.length}, preview: ${safe(tok)})`;
      results.token_type = tokenData.token_type || '(none)';
      results.user_id_from_ls = tokenData.user?.id ? `PRESENT (UUID)` : 'MISSING';
      results.user_email_from_ls = tokenData.user?.email === EMAIL ? `MATCH (${EMAIL})` : `MISMATCH: ${tokenData.user?.email}`;
      results.expires_at = tokenData.expires_at ? new Date(tokenData.expires_at * 1000).toISOString() : '(none)';

      // Test API call with token
      console.log('[STEP 6A] Calling GET /auth/me with Supabase token...');
      const apiResp = await page.evaluate(async (apiUrl, token) => {
        try {
          const r = await fetch(`${apiUrl}/auth/me`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          const body = await r.json();
          return { status: r.status, body };
        } catch (e) {
          return { status: null, error: e.message };
        }
      }, API_URL, tok);

      results.api_me_status = apiResp.status;
      if (apiResp.status === 200) {
        results.api_me_id   = apiResp.body?.id ? `PRESENT` : 'MISSING';
        results.api_me_email = apiResp.body?.email === EMAIL ? `MATCH` : `VALUE: ${apiResp.body?.email}`;
        results.api_me_body_keys = Object.keys(apiResp.body || {}).join(', ');
      } else {
        results.api_me_error = JSON.stringify(apiResp);
      }
    } else {
      results.access_token = 'MISSING or null in localStorage';
    }

    if (supabaseResponse) {
      results.supabase_response_has_session = supabaseResponse.access_token ? 'YES' : 'NO';
      results.supabase_response_error = supabaseResponse.error_code || supabaseResponse.error || '(none)';
    } else {
      results.supabase_response_has_session = 'Response not captured (may be cached)';
    }

  } catch (err) {
    results.login_error = err.message;
  }

  // ── STEP 2B: Session persistence (refresh) ──────────────────────────────────
  console.log('\n[STEP 2B] Session persistence after page reload');
  try {
    await page.reload({ waitUntil: 'networkidle', timeout: 20000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH03_after_reload.png` });
    const urlAfterReload = page.url();
    results.session_persistence = urlAfterReload.includes('/dashboard')
      ? 'PASS — still on /dashboard after reload'
      : `FAIL — redirected to ${urlAfterReload}`;
  } catch (err) {
    results.session_persistence = `ERROR: ${err.message}`;
  }

  // ── STEP 2C: Invalid login ──────────────────────────────────────────────────
  console.log('\n[STEP 2C] Invalid login test');
  try {
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await p2.route('**/api/v1/settings', route => route.abort());
    await p2.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 20000 });
    await p2.fill('input[type="email"]', 'notareal@example.com');
    await p2.fill('input[type="password"]', 'wrongpassword');

    let invalidResp = null;
    p2.on('response', async resp => {
      if (resp.url().includes('/auth/v1/token')) {
        try { invalidResp = await resp.json(); } catch {}
      }
    });

    await p2.click('button[type="submit"]');
    await p2.waitForTimeout(3000);

    const urlAfterBad = p2.url();
    const errorEl = await p2.$('p.text-red-500, [role="alert"]');
    const errorText = errorEl ? await errorEl.textContent() : '(no visible error)';

    const noToken = await p2.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.includes('auth-token') || k.includes('sb-'))) return false;
      }
      return true;
    });

    await p2.screenshot({ path: `${EVIDENCE_DIR}/AUTH04_invalid_login.png` });
    results.invalid_login_url = urlAfterBad.includes('/login') ? `PASS — still on /login` : `FAIL — ${urlAfterBad}`;
    results.invalid_login_error_shown = errorText.trim() ? `PASS — "${errorText.trim()}"` : 'FAIL — no error message';
    results.invalid_login_no_token = noToken ? 'PASS — no auth token in localStorage' : 'FAIL — token found!';
    results.invalid_supabase_error = invalidResp?.error_description || invalidResp?.error || '(not captured)';

    await ctx2.close();
  } catch (err) {
    results.invalid_login_error = err.message;
  }

  // ── STEP 2D: Logout ─────────────────────────────────────────────────────────
  console.log('\n[STEP 2D] Logout test');
  try {
    // signOut via JS in existing context
    await page.evaluate(async () => {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm');
      // Can't re-import — call via window if exposed, or just navigate to signout
    });
  } catch {}

  // Test: after logout, protected API call should fail
  // We'll check by calling /auth/me with a stale/empty token
  try {
    const meAfterLogout = await page.evaluate(async (apiUrl) => {
      const r = await fetch(`${apiUrl}/auth/me`, {
        headers: { Authorization: 'Bearer invalidtoken' }
      });
      return r.status;
    }, API_URL);
    results.invalid_token_rejected = meAfterLogout === 401
      ? 'PASS — 401 for invalid token'
      : `FAIL — got ${meAfterLogout}`;
  } catch (err) {
    results.invalid_token_rejected = `ERROR: ${err.message}`;
  }

  // ── STEP 3: Registration page check ─────────────────────────────────────────
  console.log('\n[STEP 3] Registration page inspection');
  try {
    const ctx3 = await browser.newContext();
    const p3 = await ctx3.newPage();
    await p3.goto(`${BASE_URL}/register`, { waitUntil: 'networkidle', timeout: 20000 });
    await p3.screenshot({ path: `${EVIDENCE_DIR}/AUTH05_register_page.png` });
    const hasFirstName = await p3.$('input[placeholder="Alex"]');
    const hasEmail     = await p3.$('input[type="email"]');
    const hasPassword  = await p3.$('input[type="password"]');
    const hasSubmit    = await p3.$('button[type="submit"]');
    results.register_page_fields = [
      hasFirstName ? 'firstName' : '!firstName',
      hasEmail     ? 'email'     : '!email',
      hasPassword  ? 'password'  : '!password',
      hasSubmit    ? 'submit'    : '!submit',
    ].join(', ');
    await ctx3.close();
  } catch (err) {
    results.register_page = `ERROR: ${err.message}`;
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n\n========= AUTH AUDIT RESULTS =========');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(35)} : ${v}`);
  }
  console.log('======================================\n');

  // Save results
  fs.writeFileSync(`${EVIDENCE_DIR}/auth_audit_results.json`, JSON.stringify(results, null, 2));
  console.log('Results saved to', `${EVIDENCE_DIR}/auth_audit_results.json`);

  await browser.close();
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });

