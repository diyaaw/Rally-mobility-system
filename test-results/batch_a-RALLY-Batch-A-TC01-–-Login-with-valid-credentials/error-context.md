# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: batch_a.spec.ts >> RALLY Batch-A >> TC01 – Login with valid credentials
- Location: tests\batch_a.spec.ts:167:3

# Error details

```
TimeoutError: page.waitForLoadState: Timeout 30000ms exceeded.
=========================== logs ===========================
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
  "commit" event fired
  "domcontentloaded" event fired
  "load" event fired
============================================================
```

# Page snapshot

```yaml
- main [ref=f16e2]:
  - generic [ref=f16e5]:
    - img "RALLY" [ref=f16e7]
    - generic [ref=f16e8]:
      - heading "Welcome back" [level=1] [ref=f16e9]
      - paragraph [ref=f16e10]: Sign in to reconnect with your group.
    - generic [ref=f16e11]:
      - generic [ref=f16e12]:
        - generic [ref=f16e13]: "1"
        - generic [ref=f16e14]: Sign in to your account
      - generic [ref=f16e15]:
        - generic [ref=f16e16]: "2"
        - generic [ref=f16e17]: Open your live dashboard
      - generic [ref=f16e18]:
        - generic [ref=f16e19]: "3"
        - generic [ref=f16e20]: Pick up where you left off
  - generic [ref=f16e22]:
    - generic [ref=f16e23]:
      - heading "Sign in" [level=2] [ref=f16e24]
      - paragraph [ref=f16e25]: Enter your credentials to access your dashboard.
    - generic [ref=f16e26]:
      - button "Google" [ref=f16e27] [cursor=pointer]
      - button "Github" [ref=f16e33] [cursor=pointer]
    - generic [ref=f16e37]: Or
    - generic [ref=f16e42]:
      - generic [ref=f16e43]:
        - generic [ref=f16e44]: Email
        - textbox "name@company.com" [ref=f16e46]
      - generic [ref=f16e47]:
        - generic [ref=f16e48]: Password
        - generic [ref=f16e49]:
          - textbox "••••••••" [ref=f16e50]
          - button "Show password" [ref=f16e51] [cursor=pointer]
      - button "Sign In" [ref=f16e55] [cursor=pointer]
    - paragraph [ref=f16e58]:
      - text: Don't have an account?
      - link "Create account" [ref=f16e59] [cursor=pointer]:
        - /url: /register
```

# Test source

```ts
  71  |     });
  72  |     req.on('error', reject);
  73  |     req.end();
  74  |   });
  75  | }
  76  | 
  77  | function apiPost(urlPath: string, payload: any, token?: string): Promise<any> {
  78  |   return new Promise((resolve, reject) => {
  79  |     const body = JSON.stringify(payload);
  80  |     const opts: http.RequestOptions = {
  81  |       hostname: 'localhost',
  82  |       port: 8000,
  83  |       path: urlPath,
  84  |       method: 'POST',
  85  |       headers: {
  86  |         'Content-Type': 'application/json',
  87  |         'Content-Length': Buffer.byteLength(body),
  88  |         ...(token ? { Authorization: `Bearer ${token}` } : {}),
  89  |       },
  90  |     };
  91  |     const req = http.request(opts, (res) => {
  92  |       let data = '';
  93  |       res.on('data', (d: Buffer) => (data += d));
  94  |       res.on('end', () => {
  95  |         try { resolve(JSON.parse(data)); } catch { resolve(data); }
  96  |       });
  97  |     });
  98  |     req.on('error', reject);
  99  |     req.write(body);
  100 |     req.end();
  101 |   });
  102 | }
  103 | 
  104 | /** Extract Supabase access token from localStorage. */
  105 | async function getToken(page: Page): Promise<string | null> {
  106 |   return page.evaluate(() => {
  107 |     for (let i = 0; i < localStorage.length; i++) {
  108 |       const k = localStorage.key(i)!;
  109 |       if (k.includes('supabase') || k.includes('sb-')) {
  110 |         try {
  111 |           const val = JSON.parse(localStorage.getItem(k)!);
  112 |           if (val?.access_token) return val.access_token;
  113 |           if (val?.session?.access_token) return val.session.access_token;
  114 |         } catch { continue; }
  115 |       }
  116 |     }
  117 |     return null;
  118 |   });
  119 | }
  120 | 
  121 | // ─── Shared state ────────────────────────────────────────────────────────────
  122 | 
  123 | let ctxA: BrowserContext;
  124 | let ctxB: BrowserContext;
  125 | let pageA: Page;
  126 | let pageB: Page;
  127 | let joinCode: string | null = null;
  128 | let tokenA: string | null = null;
  129 | let tokenB: string | null = null;
  130 | 
  131 | // ─── Test Suite ──────────────────────────────────────────────────────────────
  132 | 
  133 | test.describe('RALLY Batch-A', () => {
  134 | 
  135 |   test.beforeAll(async () => {
  136 |     const browser = await chromium.launch({ headless: true });
  137 | 
  138 |     // Two completely independent contexts = two separate sessions
  139 |     ctxA = await browser.newContext({
  140 |       permissions: ['geolocation'],
  141 |       geolocation: { latitude: 32.2432, longitude: 77.1892 },
  142 |     });
  143 |     ctxB = await browser.newContext({
  144 |       permissions: ['geolocation'],
  145 |       geolocation: { latitude: 32.2440, longitude: 77.1900 },
  146 |     });
  147 | 
  148 |     pageA = await ctxA.newPage();
  149 |     pageB = await ctxB.newPage();
  150 | 
  151 |     // Suppress console errors (Leaflet/Google Maps warnings etc.)
  152 |     pageA.on('console', msg => {
  153 |       if (msg.type() !== 'error') return;
  154 |     });
  155 |     pageB.on('console', msg => {
  156 |       if (msg.type() !== 'error') return;
  157 |     });
  158 |   });
  159 | 
  160 |   test.afterAll(async () => {
  161 |     await ctxA?.close();
  162 |     await ctxB?.close();
  163 |   });
  164 | 
  165 |   // ─── TC01: Login with valid credentials ──────────────────────────────────
  166 | 
  167 |   test('TC01 – Login with valid credentials', async () => {
  168 |     console.log('\n[TC01] Starting valid login test…');
  169 | 
  170 |     await pageA.goto(`${BASE_URL}/login`);
> 171 |     await pageA.waitForLoadState('networkidle');
      |                 ^ TimeoutError: page.waitForLoadState: Timeout 30000ms exceeded.
  172 | 
  173 |     // AuthInput does not use htmlFor; select by input type
  174 |     await pageA.locator('input[type="email"]').fill(USER_A.email);
  175 |     await pageA.locator('input[type="password"]').fill(USER_A.password);
  176 |     await pageA.getByRole('button', { name: /sign in/i }).click();
  177 | 
  178 |     // Wait for redirect to /dashboard
  179 |     await pageA.waitForURL(/\/dashboard/, { timeout: 25000 });
  180 | 
  181 |     const finalUrl = pageA.url();
  182 |     tokenA = await getToken(pageA);
  183 |     const hasToken = !!tokenA;
  184 | 
  185 |     console.log(`  Final URL:          ${finalUrl}`);
  186 |     console.log(`  Has session token:  ${hasToken}`);
  187 |     console.log(`  Token prefix:       ${tokenA?.substring(0, 30)}…`);
  188 | 
  189 |     await screenshot(pageA, 'TC01');
  190 | 
  191 |     expect(finalUrl).toContain('/dashboard');
  192 |     expect(hasToken).toBe(true);
  193 |   });
  194 | 
  195 |   // ─── TC02: Invalid login ─────────────────────────────────────────────────
  196 | 
  197 |   test('TC02 – Invalid login (unregistered email, wrong password)', async () => {
  198 |     console.log('\n[TC02] Starting invalid login test…');
  199 | 
  200 |     const p = await ctxA.newPage();
  201 |     await p.goto(`${BASE_URL}/login`);
  202 |     await p.waitForLoadState('networkidle');
  203 |     await p.waitForTimeout(500);
  204 | 
  205 |     await p.locator('input[type="email"]').fill('no-such-user-xyz@nowhere.invalid');
  206 |     await p.locator('input[type="password"]').fill('WrongPassword999!');
  207 |     await p.getByRole('button', { name: /sign in/i }).click();
  208 | 
  209 |     // a) Wait – page should stay on /login (no redirect expected)
  210 |     await p.waitForTimeout(6000);
  211 | 
  212 |     const currentUrl = p.url();
  213 |     const stillOnLogin = currentUrl.includes('/login') || currentUrl.endsWith('/');
  214 |     console.log(`  a) URL after invalid submit: ${currentUrl}`);
  215 |     console.log(`  a) Still on /login: ${stillOnLogin}`);
  216 | 
  217 |     // b) Error message – the login page renders {error && <p class="text-red-500 text-sm">{error}</p>}
  218 |     let errorText = '';
  219 |     // Try multiple selector strategies
  220 |     for (const sel of [
  221 |       'p.text-red-500',
  222 |       '.text-red-500',
  223 |       '[class*="text-red"]',
  224 |       'form p',
  225 |       '[role="alert"]',
  226 |     ]) {
  227 |       try {
  228 |         const els = p.locator(sel);
  229 |         const count = await els.count();
  230 |         if (count > 0) {
  231 |           const texts = await els.allTextContents();
  232 |           const nonEmpty = texts.filter(t => t.trim().length > 0);
  233 |           if (nonEmpty.length > 0) {
  234 |             errorText = nonEmpty.join(' | ');
  235 |             console.log(`  b) Error found via "${sel}": "${errorText}"`);
  236 |             break;
  237 |           }
  238 |         }
  239 |       } catch { /* next */ }
  240 |     }
  241 |     if (!errorText) {
  242 |       console.log('  b) No error element found with common selectors');
  243 |     }
  244 | 
  245 |     // c) localStorage / cookies
  246 |     const hasAuthToken = await p.evaluate(() => {
  247 |       for (let i = 0; i < localStorage.length; i++) {
  248 |         const k = (localStorage.key(i) ?? '').toLowerCase();
  249 |         if (k.includes('auth-token')) return true;
  250 |       }
  251 |       return false;
  252 |     });
  253 |     const hasSbCookie = await p.evaluate(() =>
  254 |       document.cookie.split(';').some(c => c.trim().startsWith('sb-'))
  255 |     );
  256 |     console.log(`  c) localStorage "auth-token" key present: ${hasAuthToken}`);
  257 |     console.log(`  c) Cookie starting with "sb-" present:    ${hasSbCookie}`);
  258 | 
  259 |     await screenshot(p, 'TC02');
  260 |     await p.close();
  261 | 
  262 |     expect(stillOnLogin, 'a) URL must remain on /login').toBe(true);
  263 |     expect(errorText.length, 'b) A visible error message must appear').toBeGreaterThan(0);
  264 |     expect(hasAuthToken, 'c) No "auth-token" in localStorage').toBe(false);
  265 |     expect(hasSbCookie, 'c) No sb- cookie').toBe(false);
  266 |   });
  267 | 
  268 |   // ─── TC03: Create a RALLY → join code generated ──────────────────────────
  269 | 
  270 |   test('TC03 – Create a RALLY → join code generated', async () => {
  271 |     console.log('\n[TC03] Creating a Rally group…');
```