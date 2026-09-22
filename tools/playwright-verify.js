const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { chromiumLaunchOptions } = require('./playwright-local-browser');

const OUT_DIR = '/mnt/PianoMol/in_one/PC/ui-audit-screenshots/fixed';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '4K', width: 3840, height: 2160 },
  { name: '1080p', width: 1920, height: 1080 },
  { name: 'mobile', width: 430, height: 932 },
  { name: 'small-mobile', width: 375, height: 667 },
];

const PAGES = [
  { name: 'unified-single', url: 'http://127.0.0.1:9080/app/unified-single.html' },
  { name: 'exhibition-standalone', url: 'http://127.0.0.1:9080/app/index.html?standalone=1' },
];

async function capture(pageInfo, vp) {
  const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    await page.goto(pageInfo.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2500);
    
    // Hard refresh to bypass cache
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    
    const fileName = `${pageInfo.name}__${vp.name}__${vp.width}x${vp.height}.png`;
    const filePath = path.join(OUT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false });
    
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const welcome = document.getElementById('musicmol-welcome');
      const title = document.querySelector('#musicmol-welcome .mm-welcome-title');
      const cards = document.querySelectorAll('#musicmol-welcome .mm-mode-card');
      const card0 = cards[0];
      return {
        docW: root.clientWidth, docH: root.clientHeight,
        welcomeH: welcome?.clientHeight,
        titleFontSize: title ? getComputedStyle(title).fontSize : null,
        cardCount: cards.length,
        card0W: card0?.clientWidth,
        card0H: card0?.clientHeight,
      };
    });
    
    console.log(`OK  ${fileName} -> ${JSON.stringify(layout)}`);
    await browser.close();
    return { page: pageInfo.name, vp: vp.name, layout, ok: true };
  } catch (e) {
    console.error(`ERR ${pageInfo.name}__${vp.name}: ${e.message}`);
    await browser.close();
    return { page: pageInfo.name, vp: vp.name, error: e.message, ok: false };
  }
}

(async () => {
  const results = [];
  for (const pageInfo of PAGES) {
    for (const vp of VIEWPORTS) {
      const r = await capture(pageInfo, vp);
      results.push(r);
    }
  }
  console.log(`\nDone. Screenshots saved to ${OUT_DIR}`);
})();
