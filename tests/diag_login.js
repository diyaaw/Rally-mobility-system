/**
 * Diagnostic script: What does the login page look like?
 * What happens when we try to login?
 */
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  page.on('console', msg => console.log(`CONSOLE [${msg.type()}]: ${msg.text()}`));
  page.on('pageerror', err => console.log(`PAGE ERROR: ${err.message}`));
  page.on('response', res => {
    if (res.url().includes('supabase') || res.url().includes('auth') || res.url().includes('localhost')) {
      console.log(`RESPONSE: ${res.status()} ${res.url().substring(0, 100)}`);
    }
  });

  console.log('\n=== Navigating to /login ===');
  await page.goto('http://localhost:3000/login');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log(`\nURL: ${page.url()}`);
  
  // List all inputs
  const inputs = await page.locator('input').all();
  console.log(`\nInputs found: ${inputs.length}`);
  for (let i = 0; i < inputs.length; i++) {
    const type = await inputs[i].getAttribute('type');
    const placeholder = await inputs[i].getAttribute('placeholder');
    const name = await inputs[i].getAttribute('name');
    const id = await inputs[i].getAttribute('id');
    console.log(`  Input[${i}]: type=${type}, placeholder=${placeholder}, name=${name}, id=${id}`);
  }

  // List buttons
  const buttons = await page.locator('button').all();
  console.log(`\nButtons found: ${buttons.length}`);
  for (let i = 0; i < buttons.length; i++) {
    const text = (await buttons[i].textContent())?.trim();
    const type = await buttons[i].getAttribute('type');
    console.log(`  Button[${i}]: type=${type}, text="${text}"`);
  }

  // Try to fill and submit
  console.log('\n=== Attempting login ===');
  await page.locator('input[type="email"]').fill('testuser_a@rally.test');
  await page.locator('input[type="password"]').fill('RallyTest@2024!');
  
  console.log('Fields filled, about to click Sign In...');
  
  // Listen for navigation
  const navPromise = page.waitForNavigation({ timeout: 20000 }).catch(e => `No navigation: ${e.message}`);
  
  await page.getByRole('button', { name: /sign in/i }).click();
  console.log('Clicked Sign In');
  
  const navResult = await navPromise;
  console.log(`Navigation result: ${navResult}`);
  
  await page.waitForTimeout(5000);
  console.log(`\nFinal URL: ${page.url()}`);
  
  // Check for errors
  const errorEls = await page.locator('.text-red-500, .text-red-400, [role="alert"]').allTextContents();
  console.log(`Error elements: ${JSON.stringify(errorEls)}`);
  
  // Check localStorage
  const lsKeys = await page.evaluate(() => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    return keys;
  });
  console.log(`localStorage keys: ${JSON.stringify(lsKeys)}`);

  await page.screenshot({ path: 'c:/rally/test_evidence/diagnostic_login.png' });
  await browser.close();
})().catch(console.error);

