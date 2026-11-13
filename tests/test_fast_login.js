const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => console.log('LOG:', msg.text()));

  console.log('Navigating to http://localhost:3000/login ...');
  await page.goto('http://localhost:3000/login');
  
  // Fill immediately
  await page.locator('input[type="email"]').fill('testuser_a@rally.test');
  await page.locator('input[type="password"]').fill('RallyTest@2024!');
  console.log('Submitting immediately...');
  await page.getByRole('button', { name: /sign in/i }).click();

  // Wait 5 seconds and check where we end up
  for (let i = 0; i < 8; i++) {
    console.log(`After click + ${i}s: URL is ${page.url()}`);
    await page.waitForTimeout(1000);
  }

  await browser.close();
})();

