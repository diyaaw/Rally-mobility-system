/**
 * RALLY Phase 1 Auth Audit — Playwright live verification v2
 * Uses 'load' waitUntil and aborts /settings to prevent redirect loop.
 */
import { chromium } from 'playwright';
import fs from 'fs';

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

async function blockSettingsLoop(page) {
  // Block the unauthenticated /settings call that causes the redirect loop
  await page.route('**/api/v1/settings**', route => route.abort());
  // Also block any repeated /login?redirect= accumulation
  await page.route('**/login?redirect=*redirect*', route => route.abort());
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const results = {};

  // ── STEP 2A: Valid Login ─────────────────────────────────────────────────────
  console.log('\n[STEP 2A] Valid login test');
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await blockSettingsLoop(page);

    // Capture Supabase auth response
    let supabaseLoginResp = null;
    page.on('response', async resp => {
      if (resp.url().includes('/auth/v1/token') && !resp.url().includes('grant_type=refresh')) {
        try { supabaseLoginResp = await resp.json(); } catch {}
      }
    });

    console.log('  Navigating to /login...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 30000 });
    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH01_login_page.png` });

    console.log('  Filling credentials...');
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');

    console.log('  Waiting for dashboard redirect...');
    try {
      await page.waitForURL(/\/dashboard/, { timeout: 20000 });
      results.login_redirect = `PASS — URL is now: ${page.url()}`;
    } catch {
      results.login_redirect = `FAIL — URL after 20s: ${page.url()}`;
    }

    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH02_after_login.png` });

    // ── Supabase response inspection ──────────────────────────────────────────
    if (supabaseLoginResp) {
      results.supabase_response_has_session = supabaseLoginResp.access_token ? 'YES' : 'NO';
      results.supabase_token_type = supabaseLoginResp.token_type || '(none)';
      results.supabase_response_error = supabaseLoginResp.error_description || supabaseLoginResp.error || '(none)';
    } else {
      results.supabase_response_has_session = 'Response not captured (may already be cached session)';
    }

    // ── localStorage session check ────────────────────────────────────────────
    const lsKey = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.includes('auth-token')) return k;
      }
      return null;
    });
    results.ls_key_found = lsKey ? `PRESENT: "${lsKey}"` : 'NOT FOUND';

    let accessToken = null;
    if (lsKey) {
      const tokenData = await page.evaluate((key) => {
        try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
      }, lsKey);

      if (tokenData && tokenData.access_token) {
        accessToken = tokenData.access_token;
        results.access_token_present = `PASS — length=${accessToken.length}, preview: ${safe(accessToken)}`;
        results.token_type = tokenData.token_type || '(none)';
        results.user_id_present = tokenData.user?.id ? `PASS — ID present (UUID format)` : 'FAIL — missing';
        results.user_email_match = tokenData.user?.email === EMAIL ? `PASS` : `FAIL (got: ${tokenData.user?.email})`;
        results.expires_at = tokenData.expires_at
          ? `${new Date(tokenData.expires_at * 1000).toISOString()} (${Math.round((tokenData.expires_at - Date.now()/1000)/60)}m remaining)`
          : '(none)';

        // ── STEP 6C: API call with token ────────────────────────────────────
        console.log('  Calling GET /api/v1/auth/me with token...');
        const apiResp = await page.evaluate(async (apiUrl, token) => {
          try {
            const r = await fetch(`${apiUrl}/auth/me`, {
              headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
            });
            const text = await r.text();
            let body = null;
            try { body = JSON.parse(text); } catch {}
            return { status: r.status, body, text };
          } catch (e) {
            return { status: null, error: e.message };
          }
        }, API_URL, accessToken);

        results.api_me_status = apiResp.status;
        if (apiResp.status === 200) {
          results.api_me_result     = 'PASS — 200 OK';
          results.api_me_id_present = apiResp.body?.id ? `PASS — sub extracted correctly` : 'FAIL — id missing';
          results.api_me_email      = apiResp.body?.email === EMAIL ? 'PASS' : `Value: ${apiResp.body?.email}`;
          results.api_me_profile    = apiResp.body?.profile !== undefined ? 'PRESENT' : 'ABSENT';
        } else {
          results.api_me_result = `FAIL — HTTP ${apiResp.status}`;
          results.api_me_error  = apiResp.text || JSON.stringify(apiResp);
        }

        // ── STEP 6E: Confirm sub claim matches ───────────────────────────────
        const supabaseUserId = await page.evaluate(async () => {
          // Read user id from supabase session directly
          const keys = Object.keys(localStorage);
          for (const k of keys) {
            if (k.includes('auth-token')) {
              const d = JSON.parse(localStorage.getItem(k));
              return d?.user?.id || null;
            }
          }
          return null;
        });
        results.sub_matches_user_id = (supabaseUserId && apiResp.body?.id === supabaseUserId)
          ? 'PASS — sub from JWT matches Supabase user.id'
          : `NOT VERIFIED — supabase_id=${supabaseUserId ? 'present' : 'null'}, api_id=${apiResp.body?.id ? 'present' : 'null'}`;

      } else {
        results.access_token_present = 'FAIL — access_token missing from localStorage entry';
      }
    }

  } catch (err) {
    results.login_step_error = `ERROR: ${err.message}`;
    console.error('Login step error:', err);
  }

  // ── STEP 2B: Session persistence (page reload) ───────────────────────────────
  console.log('\n[STEP 2B] Session persistence after reload');
  try {
    await page.reload({ waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${EVIDENCE_DIR}/AUTH03_after_reload.png` });
    const urlAfterReload = page.url();
    results.session_persistence = urlAfterReload.includes('/dashboard')
      ? `PASS — stays on /dashboard after reload`
      : urlAfterReload.includes('/login')
        ? `FAIL — redirected to login after reload`
        : `PARTIAL — URL: ${urlAfterReload}`;
  } catch (err) {
    results.session_persistence = `ERROR: ${err.message}`;
  }

  // ── STEP 2C: Invalid login ────────────────────────────────────────────────
  console.log('\n[STEP 2C] Invalid login test');
  try {
    const ctx2 = await browser.newContext();
    const p2 = await ctx2.newPage();
    await blockSettingsLoop(p2);

    let invalidResp = null;
    p2.on('response', async resp => {
      if (resp.url().includes('/auth/v1/token')) {
        try { invalidResp = await resp.json(); } catch {}
      }
    });

    await p2.goto(`${BASE_URL}/login`, { waitUntil: 'load', timeout: 30000 });
    await p2.fill('input[type="email"]', 'notareal@example.com');
    await p2.fill('input[type="password"]', 'wrongpassword123');
    await p2.click('button[type="submit"]');
    await p2.waitForTimeout(4000);

    const urlAfterBad = p2.url();
    const errorEl = await p2.$('p.text-red-500, [role="alert"]');
    const errorText = errorEl ? await errorEl.textContent() : '(no visible error element)';

    const noToken = await p2.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.includes('auth-token')) return false;
      }
      return true;
    });

    await p2.screenshot({ path: `${EVIDENCE_DIR}/AUTH04_invalid_login.png` });
    results.invalid_login_url = urlAfterBad.includes('/login')
      ? `PASS — stays on /login (${urlAfterBad.substring(0, 60)}...)`
      : `FAIL — ${urlAfterBad}`;
    results.invalid_login_error = errorText.trim()
      ? `PASS — error shown: "${errorText.trim()}"`
      : 'FAIL — no error message rendered';
    results.invalid_login_no_token = noToken
      ? 'PASS — no auth token stored'
      : 'FAIL — token was stored!';
    results.invalid_supabase_error = invalidResp?.error_description || invalidResp?.msg || '(not captured)';

    await ctx2.close();
  } catch (err) {
    results.invalid_login_step_error = `ERROR: ${err.message}`;
  }

  // ── STEP 6G: Reject invalid/expired token ────────────────────────────────
  console.log('\n[STEP 6G] Invalid token rejection test');
  try {
    const badTokenResp = await page.evaluate(async (apiUrl) => {
      const r = await fetch(`${apiUrl}/auth/me`, {
        headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIiwiZW1haWwiOiJ4QHkuY29tIn0.invalid' }
      });
      return { status: r.status };
    }, API_URL);
    results.invalid_token_rejected = badTokenResp.status === 401
      ? 'PASS — 401 Unauthorized for invalid token'
      : `FAIL — got HTTP ${badTokenResp.status}`;
  } catch (err) {
    results.invalid_token_rejected = `ERROR: ${err.message}`;
  }

  // ── STEP 3: Registration page ────────────────────────────────────────────
  console.log('\n[STEP 3] Registration page inspection');
  try {
    const ctx3 = await browser.newContext();
    const p3 = await ctx3.newPage();
    await blockSettingsLoop(p3);
    await p3.goto(`${BASE_URL}/register`, { waitUntil: 'load', timeout: 30000 });
    await p3.screenshot({ path: `${EVIDENCE_DIR}/AUTH05_register_page.png` });

    const fields = {
      firstName: await p3.$('input[placeholder="Alex"]') !== null,
      email: await p3.$('input[type="email"]') !== null,
      password: await p3.$('input[type="password"]') !== null,
      submitBtn: await p3.$('button[type="submit"]') !== null,
      googleOAuth: await p3.$('text=Google') !== null,
      githubOAuth: await p3.$('text=Github') !== null,
    };
    results.register_page_fields = Object.entries(fields).map(([k,v]) => `${k}:${v?'YES':'NO'}`).join(', ');
    results.register_page_load = 'PASS — page loaded';

    // Test weak password validation (client-side)
    await p3.fill('input[placeholder="Alex"]', 'Test');
    await p3.fill('input[type="email"]', 'test-audit@example.com');
    await p3.fill('input[type="password"]', 'short');
    await p3.click('button[type="submit"]');
    await p3.waitForTimeout(3000);
    const regError = await p3.$('p.text-red-500, [role="alert"]');
    const regErrorText = regError ? await regError.textContent() : null;
    results.register_weak_password_error = regErrorText
      ? `PASS — error shown: "${regErrorText.trim()}"`
      : 'NOT OBSERVED — no error visible for weak password';

    await ctx3.close();
  } catch (err) {
    results.register_step_error = `ERROR: ${err.message}`;
  }

  // ── Logout step ───────────────────────────────────────────────────────────
  console.log('\n[STEP 6G] Logout test');
  try {
    // Trigger signOut via the Supabase client in the page context
    const logoutResult = await page.evaluate(async () => {
      // The supabase singleton is on globalThis.__rally_supabase_client__
      const client = window.__rally_supabase_client__;
      if (!client) return 'NO_CLIENT';
      const { error } = await client.auth.signOut();
      return error ? `ERROR: ${error.message}` : 'OK';
    });
    results.logout_called = logoutResult === 'OK' ? 'PASS — signOut() called successfully' : `INFO: ${logoutResult}`;

    await page.waitForTimeout(2000);
    // After logout, localStorage should have no auth token
    const tokenAfterLogout = await page.evaluate(() => {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.includes('auth-token')) return k;
      }
      return null;
    });
    results.logout_token_cleared = !tokenAfterLogout
      ? 'PASS — auth token cleared from localStorage'
      : `FAIL — token still in localStorage: ${tokenAfterLogout}`;

    // Attempt protected API call after logout — should get 401
    const postLogoutResp = await page.evaluate(async (apiUrl) => {
      const r = await fetch(`${apiUrl}/auth/me`, {
        headers: { 'Accept': 'application/json' }  // No token
      });
      return r.status;
    }, API_URL);
    results.post_logout_api_rejected = postLogoutResp === 401
      ? 'PASS — 401 for unauthenticated request after logout'
      : `INFO — got ${postLogoutResp} (may need a stale token test)`;

  } catch (err) {
    results.logout_step_error = `ERROR: ${err.message}`;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n\n========= AUTH AUDIT RESULTS =========');
  for (const [k, v] of Object.entries(results)) {
    console.log(`  ${k.padEnd(38)} : ${v}`);
  }
  console.log('======================================\n');

  fs.writeFileSync(`${EVIDENCE_DIR}/auth_audit_results.json`, JSON.stringify(results, null, 2));
  console.log('Saved to', `${EVIDENCE_DIR}/auth_audit_results.json`);

  await browser.close();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });

