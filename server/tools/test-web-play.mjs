/**
 * 浏览器播放验证：用真实 Chrome 打开 /play/，确认 mkv(H.264+MP2) 片源
 * 经过服务端换封装后能在网页里真正播起来（而不是卡在"准备中 0%"）。
 */
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch { ({ chromium } = await import(process.env.KTV_PLAYWRIGHT || 'playwright-core')); }

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = 'http://127.0.0.1:9188';
const j = (r) => r.json();
const post = (p, body) =>
  fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(j);

const songs = await fetch(base + '/api/songs?q=' + encodeURIComponent('面具')).then(j);
const song = songs.items[0];
if (!song) throw new Error('测试歌曲不在库中');
await post('/api/songs/' + song.id + '?probe=1');
await post('/api/queue/clear', {});
await post('/api/queue', { songId: song.id, by: '测试' });

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/play/', { waitUntil: 'domcontentloaded' });

let ready = false;
let curTime = 0;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => {
    const v = document.querySelector('video');
    return { ready: v ? v.readyState : 0, t: v ? v.currentTime : 0, err: v && v.error ? v.error.code : 0, paused: v ? v.paused : true };
  });
  if (st.err) {
    console.log('video error code', st.err);
    break;
  }
  if (st.ready >= 2 && (st.t > 0.5 || !st.paused)) {
    ready = true;
    curTime = st.t;
    break;
  }
}
await page.screenshot({ path: 'new URL("../../shots/", import.meta.url).pathname/play-mp2.png' });
console.log(ready ? `✔ 网页已播放，currentTime=${curTime.toFixed(1)}s` : '✘ 仍未播放');
console.log('page errors:', errors.length ? errors.join(' | ') : 'none');
await browser.close();
process.exit(ready ? 0 : 1);
