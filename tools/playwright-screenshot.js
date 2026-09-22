const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { chromiumLaunchOptions } = require('./playwright-local-browser');

const OUT_DIR = '/mnt/PianoMol/in_one/PC/ui-audit-screenshots';
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const VIEWPORTS = [
  { name: '4K-desktop', width: 3840, height: 2160 },
  { name: '2K-desktop', width: 2560, height: 1440 },
  { name: '1080p-desktop', width: 1920, height: 1080 },
  { name: '1366x768-laptop', width: 1366, height: 768 },
  { name: '1280x720-hd', width: 1280, height: 720 },
  { name: 'iPad-Pro-landscape', width: 1366, height: 1024 },
  { name: 'iPad-Pro-portrait', width: 1024, height: 1366 },
  { name: 'iPhone-15-Pro-Max', width: 430, height: 932 },
  { name: 'iPhone-SE', width: 375, height: 667 },
  { name: 'small-mobile', width: 320, height: 568 },
];

const PAGES = [
  { name: 'unified-single', url: 'https://aiddpm.com/app/unified-single.html' },
  { name: 'exhibition-standalone', url: 'https://aiddpm.com/app/index.html?standalone=1' },
  { name: 'exhibition-dual', url: 'https://aiddpm.com/app/index.html' },
];

async function capture(pageInfo, vp) {
  const browser = await chromium.launch(chromiumLaunchOptions({ headless: true }));
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();

  try {
    console.log(`[${pageInfo.name}] ${vp.name} (${vp.width}x${vp.height}) loading...`);
    await page.goto(pageInfo.url, { waitUntil: 'networkidle', timeout: 30000 });
    // Wait for basic DOM
    await page.waitForTimeout(3000);
    
    const fileName = `${pageInfo.name}__${vp.name}__${vp.width}x${vp.height}.png`;
    const filePath = path.join(OUT_DIR, fileName);
    await page.screenshot({ path: filePath, fullPage: false });
    
    // Collect layout info
    const layout = await page.evaluate(() => {
      const root = document.documentElement;
      const body = document.body;
      const wrap = document.getElementById('unified-single-root') || document.getElementById('wrap');
      const title = document.getElementById('app-title');
      const welcome = document.getElementById('musicmol-welcome');
      const dock = document.getElementById('musicmol-piano-dock');
      return {
        docW: root.clientWidth,
        docH: root.clientHeight,
        bodyW: body?.clientWidth,
        bodyH: body?.clientHeight,
        wrapW: wrap?.clientWidth,
        wrapH: wrap?.clientHeight,
        titleH: title?.clientHeight,
        welcomeH: welcome?.clientHeight,
        dockH: dock?.clientHeight,
        scrollH: body?.scrollHeight,
        overflowX: body?.scrollWidth > body?.clientWidth,
        overflowY: body?.scrollHeight > body?.clientHeight,
      };
    });
    
    console.log(`  -> ${fileName}`);
    console.log(`     layout: ${JSON.stringify(layout)}`);
    
    await browser.close();
    return { page: pageInfo.name, vp: vp.name, layout, file: fileName };
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    await browser.close();
    return { page: pageInfo.name, vp: vp.name, error: e.message };
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
  
  // Write summary
  const summaryPath = path.join(OUT_DIR, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(results, null, 2));
  console.log(`\nDone. ${results.length} screenshots saved to ${OUT_DIR}`);
  console.log(`Summary: ${summaryPath}`);
})();
