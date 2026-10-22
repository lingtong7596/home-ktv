// 最终端到端验收：扫描 -> 搜索 -> 点歌 -> 自动转码 -> 推流 -> 切音轨 -> 自动切歌
const base = process.env.KTV_E2E_BASE || 'http://127.0.0.1:9188';
const j = (r) => r.json();
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(j);
const ok = (name, cond, detail = '') => {
  results.push([cond ? 'PASS' : 'FAIL', name, detail]);
  if (!cond) failed++;
};
const results = [];
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. 健康
const health = await fetch(base + '/api/health').then(j);
ok('健康检查', health.ok && health.library.total >= 0, `曲库 ${health.library.total} 首`);

// 2. 扫描
await post('/api/scan');
let scan;
for (let i = 0; i < 60; i++) {
  scan = await fetch(base + '/api/scan/status').then(j);
  if (!scan.running) break;
  await sleep(500);
}
ok('曲库扫描', !scan.running, scan.progress.message);

// 3. 搜索：拼音首字母 / 全拼 / 中文 / 目录当歌手
const zjl = await fetch(base + '/api/songs?q=zjl').then(j);
ok('拼音首字母搜索 zjl', zjl.items.length >= 2 && zjl.items.every((s) => s.artist === '周杰伦'), `命中 ${zjl.items.length} 首`);
const qt = await fetch(base + '/api/songs?q=qingtian').then(j);
ok('全拼搜索 qingtian', qt.items.some((s) => s.title === '晴天'));
const sn = await fetch(base + '/api/songs?q=%E5%8D%81%E5%B9%B4').then(j);
ok('中文搜索「十年」', sn.items.some((s) => s.title === '十年' && s.artist === '陈奕迅' && s.lang === '粤语'));

// 3b. 类型筛选（合唱 / 对唱等）
const facets = await fetch(base + '/api/facets').then(j);
ok('类型 facets', Array.isArray(facets.types) && facets.types.length > 0, facets.types.map((t) => `${t.type}:${t.count}`).join(' '));
const chorus = await fetch(base + '/api/songs?type=%E5%90%88%E5%94%B1').then(j);
ok('类型筛选 合唱', chorus.total >= 1 && chorus.items.every((s) => s.type === '合唱'), `命中 ${chorus.total} 首`);

// 4. 点歌（应自动开始播放）
const qingtian = qt.items[0];
const add = await post('/api/queue', { songId: qingtian.id, by: '验收' });
ok('点歌即播', add.started === true && add.state.current.song.title === '晴天');

// 5. 触发音轨分离并等完成（remuxOnQueue=false 时由播放器按需触发，此处用 start=1）
let prep = await fetch(`${base}/api/prepare/${qingtian.id}?track=1&start=1`).then(j);
for (let i = 0; i < 30 && prep.state !== 'ready' && prep.state !== 'error'; i++) {
  await sleep(1000);
  prep = await fetch(`${base}/api/prepare/${qingtian.id}?track=1`).then(j);
}
ok('音轨分离完成', prep.state === 'ready', `state=${prep.state}`);
const range = await fetch(`${base}/stream/${qingtian.id}?track=1`, { headers: { Range: 'bytes=0-99' } });
ok('Range 推流 206', range.status === 206, `status=${range.status} type=${range.headers.get('content-type')}`);
const raw = await fetch(`${base}/stream/${qingtian.id}?raw=1`, { method: 'HEAD' });
ok('原文件直连(raw)', raw.status === 200, `type=${raw.headers.get('content-type')}`);

// 6. 切伴唱：token 必须变化（投影仪据此重新加载）
const before = await fetch(base + '/api/state').then(j);
const toggled = await post('/api/player/toggle-track');
const t1 = before.current.token, t2 = toggled.state.current.token;
ok('切换原唱/伴唱', t2 === t1 + 1 && toggled.state.current.track === 1, `token ${t1}->${t2}`);

// 7. 排队 + 置顶 + 删除 + 自动切歌
const shiniian = sn.items[0];
const add2 = await post('/api/queue', { songId: shiniian.id, by: '爸爸' });
ok('加入队列', add2.position === 1);
const gy = await fetch(base + '/api/songs?q=gyz').then(j);
const add3 = await post('/api/queue', { songId: gy.items[0].id, by: '妈妈' });
ok('队列顺序', add3.state.queue.length === 2);
const qid2 = add3.state.queue[0].qid;
const top = await post(`/api/queue/${qid2}/top`);
ok('置顶', top.state.queue[0].song.title === '十年');
await post(`/api/queue/${top.state.queue[0].qid}/remove`);
const st1 = await fetch(base + '/api/state').then(j);
ok('删除队列项', st1.queue.length === 1);
await post('/api/player/next');
const st2 = await fetch(base + '/api/state').then(j);
ok('切歌', st2.current && st2.current.song.title === '孤勇者');

// 8. 上报结束 -> 自动下一首
await post('/api/player/report', { ended: true });
const st3 = await fetch(base + '/api/state').then(j);
ok('播完自动接歌', st3.current === null && st3.queue.length === 0, '队列已清空');

// 9. 二维码
const qr = await fetch(base + '/api/qr.svg?text=http://x/m/');
const svg = await qr.text();
ok('二维码生成', qr.status === 200 && svg.startsWith('<svg'), `${svg.length} 字节`);

console.log(results.map(([s, n, d]) => `${s}  ${n}${d ? '  (' + d + ')' : ''}`).join('\n'));
console.log(failed ? `\n${failed} 项未通过` : '\n全部通过 ✔');
