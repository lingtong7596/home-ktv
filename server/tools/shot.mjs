let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import(process.env.KTV_PLAYWRIGHT || 'playwright-core')); }

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'new URL("../../shots/", import.meta.url).pathname';
const base = 'http://127.0.0.1:9188';
const j = (r) => r.json();
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(j);

// 确保有收藏（收藏 Tab 截图用）
{
  const songs = await fetch(base + '/api/songs?q=qingtian').then(j);
  if (songs.items[0]) await post('/api/favs/toggle', { songId: songs.items[0].id });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });

async function shot(url, file, viewport, waitMs = 1500, action) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto(base + url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (action) await action(page);
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log(`${file}  errors=${errors.length ? errors.join(' | ') : 'none'}`);
  await ctx.close();
}

// 手机端
await shot('/m/', 'phone-list.png', { width: 390, height: 844 }, 1600, async (page) => {
  await page.fill('#q', 'zjl');
  await page.waitForTimeout(900);
});
await shot('/m/', 'phone-artists.png', { width: 390, height: 844 }, 1600, async (page) => {
  await page.click('#tabs button[data-tab="artists"]');
});
await shot('/m/', 'phone-favs.png', { width: 390, height: 844 }, 1600, async (page) => {
  await page.click('#tabs button[data-tab="favs"]');
});
await shot('/m/', 'phone-queue.png', { width: 390, height: 844 }, 1600, async (page) => {
  await page.click('#tabs button[data-tab="queue"]');
});

// 管理后台
await shot('/admin/', 'admin-songs.png', { width: 1180, height: 950 }, 2000, async (page) => {
  // 勾选前两首，展示批量操作条
  const boxes = await page.$$('#songRows input.pick');
  for (const b of boxes.slice(0, 3)) await b.click();
  await page.waitForTimeout(400);
});
await shot('/admin/', 'admin-artists.png', { width: 1180, height: 950 }, 1600, async (page) => {
  await page.click('nav button[data-tab="artists"]');
});
await shot('/admin/', 'admin-favs.png', { width: 1180, height: 950 }, 1600, async (page) => {
  await page.click('nav button[data-tab="favs"]');
});
await shot('/admin/', 'admin-import.png', { width: 1180, height: 950 }, 1600, async (page) => {
  await page.click('nav button[data-tab="import"]');
});
await shot('/admin/', 'admin-settings.png', { width: 1180, height: 950 }, 1600, async (page) => {
  await page.click('nav button[data-tab="settings"]');
});

// 播放页（新控制条：重唱/收藏）
await shot('/play/', 'player-idle.png', { width: 1280, height: 720 }, 1500);

await browser.close();
