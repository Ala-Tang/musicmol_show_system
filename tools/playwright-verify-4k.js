const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { chromiumLaunchOptions } = require('./playwright-local-browser');

const OUT_DIR = '/mnt/PianoMol/in_one/PC/ui-audit-screenshots/fixed';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

async function capture(vp) {
  const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await page.goto('http://127.0.0.1:9080/app/unified-single.html', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    
    const fileName = `unified-single__${vp.name}__${vp.width}x${vp.height}_v2.png`;
    const filePath = path.join(OUT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false });
    
    const layout = await page.evaluate(() => {
      const title = document.querySelector('#musicmol-welcome .mm-welcome-title');
      const cards = document.querySelectorAll('#musicmol-welcome .mm-mode-card');
      const card0 = cards[0];
      return {
        titleFontSize: title ? getComputedStyle(title).fontSize : null,
        card0W: card0?.clientWidth,
        card0H: card0?.clientHeight,
      };
    });
    
    console.log(`${fileName} -> ${JSON.stringify(layout)}`);
    await browser.close();
  } catch (e) {
    console.error(`ERR: ${e.message}`);
    await browser.close();
  }
}

(async () => {
  await capture({ name: '4K', width: 3840, height: 2160 });
  await capture({ name: '1080p', width: 1920, height: 1080 });
  await capture({ name: 'small-mobile', width: 375, height: 667 });
})();
