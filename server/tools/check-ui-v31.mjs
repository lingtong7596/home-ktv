/**
 * v3.1 网页验收：点歌台 iframe 打开时，歌曲信息条/控制条不得叠上来
 */
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import(process.env.KTV_PLAYWRIGHT || 'playwright-core')); }

const BASE = process.env.KTV_BASE || 'http://127.0.0.1:9188';
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✘ ${name}  ${extra}`); }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE + '/play/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

// 先随便放一首（选 h264 的歌）
const songs = await page.evaluate(async () => {
  const r = await fetch('/api/songs?limit=100').then((x) => x.json());
  return (r.items || []).filter((s) => s.vcodec === 'h264').slice(0, 5).map((s) => s.id);
});
if (songs.length) {
  await page.evaluate((id) => fetch('/api/queue', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: id, by: '验收' }),
  }), songs[0]);
  await page.waitForTimeout(2500);
}

// 打开点歌台
await page.click('#btnBrowser');
await page.waitForTimeout(1200);
ok('点歌台已打开', await page.$eval('#browser', (el) => el.classList.contains('show')));

// 模拟鼠标移动（以前会把歌曲信息条重新盖上来）
await page.mouse.move(683, 380);
await page.mouse.move(683, 200);
await page.waitForTimeout(600);
ok('点歌台打开时歌曲信息条被隐藏', await page.$eval('#topbar', (el) => !el.classList.contains('show')));
ok('点歌台打开时控制条被隐藏', await page.$eval('#controls', (el) => !el.classList.contains('show')));

// 关掉点歌台后信息条恢复
await page.click('#btnBrowserClose');
await page.waitForTimeout(600);
ok('关闭点歌台后歌曲信息条恢复', await page.$eval('#topbar', (el) => el.classList.contains('show')));

// 截图留档
await page.mouse.move(683, 380);
await page.waitForTimeout(800);
await page.screenshot({ path: '../shots/v31-play-controls.png' });
await page.click('#btnBrowser');
await page.waitForTimeout(1500);
await page.screenshot({ path: '../shots/v31-play-browser.png' });

ok('页面无 JS 报错', errors.length === 0, errors.join('; ').slice(0, 120));

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
