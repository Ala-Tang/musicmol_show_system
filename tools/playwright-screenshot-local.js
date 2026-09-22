const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { chromiumLaunchOptions } = require('./playwright-local-browser');

const OUT_DIR = '/mnt/PianoMol/in_one/PC/ui-audit-screenshots';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '4K', width: 3840, height: 2160 },
  { name: '1080p', width: 1920, height: 1080 },
  { name: '720p', width: 1280, height: 720 },
  { name: 'iPad-landscape', width: 1366, height: 1024 },
  { name: 'iPad-portrait', width: 1024, height: 1366 },
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
    
    const fileName = `${pageInfo.name}__${vp.name}__${vp.width}x${vp.height}.png`;
    const filePath = path.join(OUT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false });
    
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const wrap = document.getElementById('unified-single-root') || document.getElementById('wrap');
      const title = document.getElementById('app-title');
      const welcome = document.getElementById('musicmol-welcome');
      const dock = document.getElementById('musicmol-piano-dock');
      return {
        docW: root.clientWidth, docH: root.clientHeight,
        bodyW: body?.clientWidth, bodyH: body?.clientHeight,
        wrapW: wrap?.clientWidth, wrapH: wrap?.clientHeight,
        titleH: title?.clientHeight, welcomeH: welcome?.clientHeight, dockH: dock?.clientHeight,
        scrollH: body?.scrollHeight,
        overflowX: (body?.scrollWidth || 0) > (body?.clientWidth || 0),
        overflowY: (body?.scrollHeight || 0) > (body?.clientHeight || 0),
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
  const summaryPath = path.join(OUT_DIR, 'summary-local.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nDone. Summary: ${summaryPath}`);
})();
