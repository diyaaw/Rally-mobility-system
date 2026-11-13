const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('Navigating to http://localhost:3000/login ...');
  await page.goto('http://localhost:3000/login');
  
  // Let's observe for 5 seconds what happens to the URL
  for (let i = 0; i < 5; i++) {
    console.log(`Second ${i}: URL is ${page.url()}`);
    await page.waitForTimeout(1000);
  }

  await browser.close();
})();

