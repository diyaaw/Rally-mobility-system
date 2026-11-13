const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.route('**/api/v1/settings', route => route.abort());

  page.on('console', msg => console.log('LOG:', msg.text()));

  console.log('Navigating to http://localhost:3000/login for valid login...');
  await page.goto('http://localhost:3000/login');
  await page.waitForTimeout(1000);

  await page.locator('input[type="email"]').fill('testuser_a@rally.test');
  await page.locator('input[type="password"]').fill('RallyTest@2024!');
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForTimeout(6000);
  console.log('URL after valid submit:', page.url());

  const ls = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
      items[localStorage.key(i)] = localStorage.getItem(localStorage.key(i))?.substring(0, 50);
    }
    return items;
  });
  console.log('localStorage items:', JSON.stringify(ls));

  await browser.close();
})();

