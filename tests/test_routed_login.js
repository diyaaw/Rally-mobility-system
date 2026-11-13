const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // If we route /api/v1/settings to abort
  await page.route('**/api/v1/settings', route => route.abort());

  page.on('console', msg => console.log('LOG:', msg.text()));

  console.log('Navigating to http://localhost:3000/login with routed settings...');
  await page.goto('http://localhost:3000/login');
  await page.waitForTimeout(2000);
  console.log('URL after 2s:', page.url());

  // Try TC02: unregistered email + wrong password
  await page.locator('input[type="email"]').fill('no-such-user-xyz@nowhere.invalid');
  await page.locator('input[type="password"]').fill('WrongPassword999!');
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForTimeout(4000);
  console.log('URL after submit:', page.url());
  const errorEls = await page.locator('.text-red-500, .text-red-400, [role="alert"]').allTextContents();
  console.log('Error elements:', JSON.stringify(errorEls));

  await browser.close();
})();

