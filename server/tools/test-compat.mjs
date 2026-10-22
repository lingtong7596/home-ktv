/**
 * 播放兼容性验收：MP2 音频片源（用户真实格式）能不能在投影仪/浏览器上播。
 *
 * 前置：服务已在本机 9188 运行，曲库指向 test-media（含 mp2 样本）
 * 用法：node tools/test-compat.mjs
 */
import { execFileSync } from 'node:child_process';

const base = 'http://127.0.0.1:9188';
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`); }
  else { fail++; console.log(`  ✘ ${name} ${extra}`); }
};

const j = async (p, o) => {
  const r = await fetch(base + p, o);
  return { code: r.status, data: await r.json().catch(() => ({})) };
};
const post = (p, body) =>
  j(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findSong(q) {
  const r = await j(`/api/songs?q=${encodeURIComponent(q)}&limit=50&status=all`);
  return (r.data.items || [])[0];
}

/** 轮询 prepare 直到 ready/unsupported/error，返回最终状态 */
async function prepare(songId, track, client, compat = false, timeoutMs = 90000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const r = await j(
      `/api/prepare/${songId}?track=${track}&client=${client}&start=1${compat ? '&compat=1' : ''}`,
    );
    last = r.data;
    if (['ready', 'unsupported', 'error', 'off'].includes(last.state)) return last;
    await sleep(500);
  }
  return last;
}

console.log('== 一、重新扫描（含 mp2 样本）==');
await post('/api/scan', { filenameOrder: 'artist-title', deepScan: false });
for (let i = 0; i < 40; i++) {
  const st = await j('/api/scan/status');
  if (!st.data.running && ['done', 'idle'].includes(st.data.progress?.phase)) break;
  await sleep(500);
}
const mkv = await findSong('面具');
const mpg = await findSong('爱与痛的边缘');
const aac = await findSong('七里香');
ok('找到 mp2 音轨的 mkv', !!mkv, JSON.stringify(mkv && mkv.title));
ok('找到 mpeg2 的 mpg', !!mpg, JSON.stringify(mpg && mpg.title));
ok('找到 h264+aac 的 mkv', !!aac, JSON.stringify(aac && aac.title));

console.log('== 二、mark 属性探测（懒探测补齐编码）==');
{
  const r = await j(`/api/songs/${mkv.id}?probe=1`);
  ok('mkv 探测到 h264 + 2×mp2', r.data.vcodec === 'h264' && r.data.audios.every((a) => a.codec === 'mp2'),
    JSON.stringify({ v: r.data.vcodec, a: r.data.audios.map((x) => x.codec) }));
  const r2 = await j(`/api/songs/${mpg.id}?probe=1`);
  ok('mpg 探测到 mpeg2video + 2×mp2', r2.data.vcodec === 'mpeg2video' && r2.data.audios.every((a) => a.codec === 'mp2'),
    JSON.stringify({ v: r2.data.vcodec, a: r2.data.audios.map((x) => x.codec) }));
}

console.log('== 三、投影仪（client=apk）==');
{
  const t0 = Date.now();
  const r = await prepare(mkv.id, 0, 'apk');
  ok('mkv+mp2 → 转封装完成', r.state === 'ready', JSON.stringify(r.state) + ' ' + (r.error || ''));
  const cost = Date.now() - t0;
  ok('12 秒素材处理 <25s', cost < 25000, `${cost}ms`);

  const head = await fetch(base + `/stream/${mkv.id}?track=0&client=apk`, { method: 'HEAD' });
  ok('兼容流可下载', head.status === 200, `code=${head.status}`);
  const ctype = head.headers.get('content-type') || '';
  ok('返回 mp4 容器', ctype.includes('mp4'), ctype);
}
{
  const r = await prepare(mpg.id, 1, 'apk');
  ok('mpg(mpeg2)+mp2 → 转封装完成', r.state === 'ready', JSON.stringify(r.state) + ' ' + (r.error || ''));
  const head = await fetch(base + `/stream/${mpg.id}?track=1&client=apk`, { method: 'HEAD' });
  ok('mpg 兼容流可下载', head.status === 200, `code=${head.status}`);
  const ctype = head.headers.get('content-type') || '';
  ok('MPEG-2 走 ts 容器', ctype.includes('mp2t') || ctype.includes('mpegts') || ctype.includes('video/mp2t'), ctype);
}

console.log('== 四、浏览器（client=web）==');
{
  const r = await prepare(aac.id, 0, 'web');
  ok('h264+aac 的 mkv 也能给浏览器播', r.state === 'ready', JSON.stringify(r.state));
}
{
  const r = await prepare(mpg.id, 0, 'web');
  ok('mpg 明确告知浏览器播不了', r.state === 'unsupported', JSON.stringify(r.state));
  ok('提示文案可读', /浏览器|投影仪/.test(r.error || ''), r.error || '');
  const head = await fetch(base + `/stream/${mpg.id}?track=0&client=web`, { method: 'HEAD' });
  ok('浏览器请求 mpg 返回 415 而不是空转', head.status === 415, `code=${head.status}`);
}

console.log('== 五、验证视频没有被转码（关键）==');
{
  const r = await prepare(mkv.id, 0, 'apk');
  const detail = await j(`/api/songs/${mkv.id}?probe=1`);
  const mediaDir = (await j('/api/settings')).data.mediaDirs?.[0] || '';
  const src = detail.data.rel ? `${mediaDir}/${detail.data.rel}`.replace(/\\/g, '/') : '';
  ok('拿到源文件路径', !!src, String(src));
  const cacheFile = `${process.cwd()}/cache/${mkv.id}_a0.mp4`;
  const md5 = (file, map) => {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', map, '-c', 'copy', '-f', 'md5', '-'], {
      encoding: 'utf8',
    });
    return out.trim();
  };
  ok('视频流逐帧一致（-c:v copy 验证）', md5(src, '0:v:0') === md5(cacheFile, '0:v:0'), 'video md5 不同=被转码了');
  const probe = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', cacheFile],
    { encoding: 'utf8' },
  ).trim().split('\n');
  ok('音频已转为 aac', probe.includes('aac'), probe.join(','));
  ok('音频只有选中那一条（不叠加）', probe.filter((x) => x === 'aac').length === 1, probe.join(','));
  void r;
}

console.log('== 六、旧行为兼容 ==');
{
  const head = await fetch(base + `/stream/${mkv.id}?raw=1`, { method: 'HEAD' });
  ok('raw=1 仍直出原文件', head.status === 200 && (head.headers.get('content-type') || '').includes('matroska'),
    head.headers.get('content-type'));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
