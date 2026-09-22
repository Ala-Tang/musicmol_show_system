const { chromium } = require('playwright');
const path = require('path');
const OUT = '/mnt/PianoMol/in_one/PC/ui-audit-screenshots';
const CHROME = '/mnt/PianoMol/in_one/PC/painojs/chrome-linux64/chrome';
const BASE = 'http://127.0.0.1:9080/app/unified-single.html';
const VP = { width: 1920, height: 1080 };

async function cap(page, name) {
  await page.screenshot({ path: path.join(OUT, `dt-${name}.png`), fullPage: false });
  console.log('shot', name);
}
async function visibleTools(page) {
  return page.evaluate(() => {
    const ids = ['top-right-ui','icon-embed-effect2','icon-midi-fx-demo','corner-icons','icon-sample-key','corner-icon-custom-mol','icon-model-test'];
    const r = {};
    for (const id of ids) { const e = document.getElementById(id); if(!e){r[id]='absent';continue;} const b=e.getBoundingClientRect(); const c=getComputedStyle(e); r[id]= (c.display!=='none'&&b.width>0)?`${Math.round(b.width)}x${Math.round(b.height)}`:'hidden'; }
    return r;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('unifiedPianoDockCollapsed','0'); } catch(e){} });
  const page = await ctx.newPage();

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // 进入「音乐生成分子」模式（点欢迎卡片）
  try { await page.click('.mm-mode-card[data-route="music2mol"]'); console.log('clicked music2mol card'); } catch(e){ console.log('card click fail', e.message); }
  await page.waitForTimeout(2500);
  console.log('tools after music2mol:', JSON.stringify(await visibleTools(page)));
  await cap(page, 'm2m-entered');

  // 数据大屏（右上角 icon-embed-effect2）
  try { await page.click('#icon-embed-effect2', { timeout: 2500 }); await page.waitForTimeout(2000); await cap(page,'data-dashboard'); } catch(e){ console.log('dashboard fail', e.message); }

  // 自定义分子 SMILES 面板
  try { await page.click('#corner-icon-custom-mol', { timeout: 2500 }); await page.waitForTimeout(1500); await cap(page,'custom-mol'); } catch(e){ console.log('custom-mol fail', e.message); }

  await ctx.close();

  // mol2music 模式：样例药物层
  const ctx2 = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  await ctx2.addInitScript(() => { try { sessionStorage.setItem('unifiedPianoDockCollapsed','0'); } catch(e){} });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(2500);
  try { await p2.click('.mm-mode-card[data-route="mol2music"]'); console.log('clicked mol2music card'); } catch(e){ console.log('card2 fail', e.message); }
  await p2.waitForTimeout(2500);
  console.log('tools after mol2music:', JSON.stringify(await visibleTools(p2)));
  await cap(p2, 'mol2music-entered');
  try { await p2.click('#icon-sample-key', { timeout: 2500 }); await p2.waitForTimeout(2500); await cap(p2,'sample-drug'); } catch(e){ console.log('sample fail', e.message); }
  await ctx2.close();

  await browser.close();
  console.log('done');
})();
