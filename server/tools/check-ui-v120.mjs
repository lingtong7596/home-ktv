/**
 * v1.2.0 手机端验收：
 *  1. 歌名大类不再有字母条；搜索不带歌手拼音首字母（qscope=title）
 *  2. 底部五个大类：歌名/歌星/预览/收藏/已点
 *  3. 收藏、已点有筛选框
 *  4. 预览页能拉起当前歌的兼容流
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

// ---- 接口层：qscope ----
// 列表接口不回 pinyin 字段，直接用已知样本：zjl = 周杰伦歌手首字母（歌名里不含 zjl）
const noScope = await fetch(BASE + '/api/songs?q=zjl').then((x) => x.json());
const withScope = await fetch(BASE + '/api/songs?q=zjl&qscope=title').then((x) => x.json());
ok('qscope=title 时歌手首字母不再命中',
  noScope.items.some((s) => s.artist === '周杰伦') && !withScope.items.some((s) => s.artist === '周杰伦'),
  `不带scope=${noScope.total} 带scope=${withScope.total}`);
const byTitle = await fetch(BASE + '/api/songs?q=qt&qscope=title').then((x) => x.json());
ok('歌名首字母仍可搜（qt=晴天）', byTitle.items.some((s) => s.title === '晴天'), `total=${byTitle.total}`);

// ---- 页面层 ----
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE + '/m/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

ok('歌名大类没有字母条', await page.$('#letters') === null);
ok('歌星大类没有字母条', await page.$('#aLetters') === null);

const tabs = await page.$$eval('#tabs button', (bs) => bs.map((b) => b.textContent.trim()));
ok('底部五个大类（歌名/歌星/预览/收藏/已点）', tabs.length === 5 && tabs[2].includes('预览'), tabs.join('|'));

// 收藏筛选
await page.click('#tabs button[data-tab="favs"]');
await page.waitForTimeout(800);
ok('收藏页有筛选框', await page.$('#favQ') !== null);
// 先收藏一首再筛选
const songs = await page.evaluate(async () => (await (await fetch('/api/songs?limit=10')).json()).items);
if (songs.length) {
  await page.evaluate(async (id) => { await fetch('/api/favs/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: id }) }); }, songs[0].id);
  await page.click('#tabs button[data-tab="favs"]');
  await page.waitForTimeout(800);
  const before = await page.$$eval('#favList .song', (n) => n.length);
  await page.fill('#favQ', 'zzzz不存在的歌');
  await page.waitForTimeout(600);
  const after = await page.$$eval('#favList .song', (n) => n.length);
  ok('收藏筛选生效', before >= 1 && after === 0, `before=${before} after=${after}`);
  await page.fill('#favQ', '');
  await page.waitForTimeout(500);
}

// 已点筛选
await page.click('#tabs button[data-tab="queue"]');
await page.waitForTimeout(500);
ok('已点页有筛选框', await page.$('#qQ') !== null);

// 预览页
const h264 = await page.evaluate(async () => {
  const r = await (await fetch('/api/songs?limit=60')).json();
  return (r.items || []).find((s) => s.vcodec === 'h264');
});
if (h264) {
  await page.evaluate(async (id) => {
    await fetch('/api/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ songId: id, by: '验收' }) });
  }, h264.id);
  await page.waitForTimeout(2500);
  await page.click('#tabs button[data-tab="preview"]');
  await page.waitForTimeout(4000);
  const hasVideo = await page.$('#previewVideo') !== null;
  ok('预览页出现视频画面（h264 片源）', hasVideo);
  if (hasVideo) {
    await page.screenshot({ path: '../shots/v120-phone-preview.png' });
  }
} else {
  console.log('  （曲库里没有 h264 样本，跳过预览视频检查）');
}

ok('页面无 JS 报错', errors.length === 0, errors.join('; ').slice(0, 160));

await page.click('#tabs button[data-tab="sing"]');
await page.waitForTimeout(800);
await page.screenshot({ path: '../shots/v120-phone-sing.png' });

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
