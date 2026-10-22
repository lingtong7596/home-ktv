let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import(process.env.KTV_PLAYWRIGHT || 'playwright-core')); }

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'new URL("../../shots/", import.meta.url).pathname';
const base = 'http://127.0.0.1:9188';
const j = (r) => r.json();
const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);

let pass = 0;
let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ✔ ${n}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ✘ ${n}  ${extra}`); }
};

// 准备：清队列 + 点一首浏览器能播的（H.264/mkv）；mpg 是 MPEG-2，网页端本来就会提示去投影仪看
await post('/api/queue/clear');
await post('/api/player/next'); // 清掉可能在播的
const songs = await fetch(base + '/api/songs?sort=default&limit=50').then(j);
const target = songs.items.find((s) => (s.vcodec || 'h264') === 'h264' && !s.disabled) || songs.items[0];
await post('/api/queue', { songId: target.id, by: 'UI测试' });
await post('/api/player/pause'); // 先暂停，避免自动播放策略干扰

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
await page.goto(base + '/play/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

/** 控制条会自动隐藏，先把鼠标晃出来再点（真实用户也是这么用的） */
async function uiClick(sel) {
  await page.mouse.move(683, 400);
  await page.waitForTimeout(350);
  await page.click(sel);
  await page.waitForTimeout(250);
}

// 恢复播放
await post('/api/player/resume');
await page.waitForTimeout(2500);

console.log('== 一、点画面暂停要"停得住" ==');
{
  await page.click('video', { position: { x: 400, y: 300 } });
  await page.waitForTimeout(1200);
  const p1 = await page.evaluate(() => document.querySelector('video').paused);
  await page.waitForTimeout(5000);
  const st = await fetch(base + '/api/state').then(j);
  const p2 = await page.evaluate(() => document.querySelector('video').paused);
  ok('点击画面后暂停', p1 === true);
  ok('5 秒后仍然是暂停（不会自己续播）', p2 === true, `video.paused=${p2}`);
  ok('服务端状态也是暂停', st.current && st.current.paused === true, `server paused=${st.current && st.current.paused}`);
}

console.log('\n== 二、收藏按钮状态 ==');
{
  const before = await page.evaluate(() => document.getElementById('btnFav').className);
  await uiClick('#btnFav');
  await page.waitForTimeout(1200);
  const on = await page.evaluate(() => document.getElementById('btnFav').className);
  const text = await page.evaluate(() => document.getElementById('btnFav').textContent);
  ok('点击后变"已收藏"', on.includes('fav-on') && text.includes('已收藏'), `${before} → ${on} / ${text}`);
  await uiClick('#btnFav');
  await page.waitForTimeout(1200);
  const off = await page.evaluate(() => document.getElementById('btnFav').className);
  ok('再点取消收藏', !off.includes('fav-on'), off);
}

console.log('\n== 三、已点侧栏能关掉 ==');
{
  await uiClick('#btnQueue');
  await page.waitForTimeout(700);
  const shown = await page.evaluate(() => document.getElementById('queuePanel').classList.contains('show'));
  ok('点"已点"能打开侧栏', shown);
  await page.screenshot({ path: `${OUT}/play-queue.png` });
  await page.mouse.click(300, 400); // 点空白处
  await page.waitForTimeout(700);
  const hidden = await page.evaluate(() => document.getElementById('queuePanel').classList.contains('show'));
  ok('点空白处能关掉侧栏', !hidden);
  await uiClick('#btnQueue');
  await page.waitForTimeout(500);
  await uiClick('#btnQueueClose');
  await page.waitForTimeout(600);
  const hidden2 = await page.evaluate(() => document.getElementById('queuePanel').classList.contains('show'));
  ok('关闭按钮能关掉侧栏', !hidden2);
}

console.log('\n== 四、播放页里能直接点歌 ==');
{
  await uiClick('#btnBrowser');
  await page.waitForTimeout(2500);
  const vis = await page.evaluate(() => document.getElementById('browser').classList.contains('show'));
  const framed = await page.evaluate(() => {
    const f = document.getElementById('browserFrame');
    return f && f.contentDocument && f.contentDocument.querySelectorAll('#tabs button').length;
  });
  ok('点歌台能打开', vis);
  ok('点歌台内容已加载', framed === 4, `tabs=${framed}`);
  await page.screenshot({ path: `${OUT}/play-browser.png` });
  await uiClick('#btnBrowserClose');
  await page.waitForTimeout(600);
  const vis2 = await page.evaluate(() => document.getElementById('browser').classList.contains('show'));
  ok('能返回播放页', !vis2);
}

console.log('\n== 五、队列打乱 / 置顶 ==');
{
  const more = songs.items.slice(1, 4);
  for (const s of more) await post('/api/queue', { songId: s.id, by: 'UI测试' });
  await page.waitForTimeout(1500);
  const before = (await fetch(base + '/api/state').then(j)).queue.map((q) => q.song.id).join(',');
  await uiClick('#btnQueue');
  await page.waitForTimeout(500);
  await uiClick('#btnQShuffle');
  await page.waitForTimeout(900);
  const after = (await fetch(base + '/api/state').then(j)).queue.map((q) => q.song.id).join(',');
  ok('打乱接口生效（顺序有变化）', before !== after || before.split(',').length < 3, `${before} → ${after}`);
  await uiClick('#btnQueueClose');
}

console.log('\n== 六、页面无 JS 报错 ==');
ok('控制台无 error', errors.length === 0, errors.slice(0, 3).join(' | '));

await page.screenshot({ path: `${OUT}/play-controls.png` });
await browser.close();

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
