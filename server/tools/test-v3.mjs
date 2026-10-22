/**
 * v3 验收：批量操作 / 队列打乱 / 音轨延续 / 暂停可靠 / 点歌预热 / 去口令
 * 用法：先启动服务端，再 node tools/test-v3.mjs
 */
const BASE = process.env.KTV_BASE || 'http://127.0.0.1:9188';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}${extra ? '  ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✘ ${name}  ${extra}`);
  }
}

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const d = await r.json().catch(() => ({}));
  return { code: r.status, ...d, data: d };
}
const post = (p, body) =>
  fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(
    async (r) => ({ code: r.status, ...(await r.json().catch(() => ({}))) }),
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 上一轮测试可能移除过歌曲，先重扫一遍把曲库恢复干净 */
async function rescan() {
  await post('/api/songs/restore-removed');
  await post('/api/scan', {});
  for (let i = 0; i < 60; i++) {
    const s = await j('/api/scan/status');
    if (!s.running) return;
    await sleep(500);
  }
}

console.log('== 一、后台免口令 ==');
{
  const s = await j('/api/settings');
  ok('设置接口不需要口令', s.code === 200 && s.roomName != null, `code=${s.code}`);
  ok('已无 adminPinSet 字段', s.adminPinSet === undefined);
}

console.log('\n== 二、批量收藏 / 取消收藏 ==');
let pool = [];
{
  await rescan();
  const r = await j('/api/songs?limit=5');
  pool = r.items.map((x) => x.id);
  await post('/api/songs/batch', { ids: pool, action: 'unfav' });
  const a = await post('/api/songs/batch', { ids: pool, action: 'fav' });
  ok('批量收藏', a.affected === pool.length, `affected=${a.affected}`);
  const favs = await j('/api/favs');
  ok('收藏列表已包含', pool.every((id) => favs.items.some((s) => s.id === id)));
  const b = await post('/api/songs/batch', { ids: pool, action: 'unfav' });
  ok('批量取消收藏', b.affected === pool.length, `affected=${b.affected}`);
  const st = await j('/api/state');
  ok('state.favIds 同步', !pool.some((id) => st.favIds.includes(id)));
}

console.log('\n== 三、批量加入已点 + 打乱 ==');
{
  await post('/api/queue/clear');
  await post('/api/player/next');
  const r = await post('/api/songs/batch', { ids: pool, action: 'queue' });
  ok('批量加入已点', r.affected >= 2, `affected=${r.affected}`);
  const st = await j('/api/state');
  const before = st.queue.map((q) => q.song.id).join(',');
  await post('/api/queue/shuffle');
  const st2 = await j('/api/state');
  ok('队列打乱接口可用', st2.queue.length === st.queue.length, `${before} → ${st2.queue.map((q) => q.song.id).join(',')}`);
  ok('打乱后数量不变', st2.queue.length === st.queue.length);
}

console.log('\n== 四、音轨角色延续 ==');
{
  const st = await j('/api/state');
  const cur = st.current;
  ok('当前曲目带 trackRole 字段', !!cur && (cur.trackRole === 'orig' || cur.trackRole === 'acc'), cur && cur.trackRole);
  // 切一次伴唱，然后切歌，检查下一首仍是伴唱角色
  const t = await post('/api/player/toggle-track');
  const s2 = t.state || (await j('/api/state'));
  const want = s2.trackRole;
  await post('/api/player/next');
  const s3 = await j('/api/state');
  const multi = s3.current && s3.current.trackCount > 1;
  ok('切歌后延续音轨角色', s3.trackRole === want && (!multi || s3.current.trackRole === want),
    `${want} → 全局${s3.trackRole} / 本曲${s3.current && s3.current.trackRole}（音轨数${s3.current && s3.current.trackCount}）`);
  // 还原成原唱
  if ((await j('/api/state')).trackRole === 'acc') await post('/api/player/toggle-track');
}

console.log('\n== 五、暂停可靠（report 不再把 paused 顶回来）==');
{
  const st = await j('/api/state');
  if (!st.current) {
    const r = await post('/api/queue', { songId: pool[0], by: 'test' });
    ok('准备一首在播', r.code === 200);
  }
  await post('/api/player/pause');
  await post('/api/player/report', { position: 3, paused: false });
  await post('/api/player/report', { position: 4, paused: false });
  const s = await j('/api/state');
  ok('上报 paused:false 不会取消暂停', s.current.paused === true, `paused=${s.current.paused}`);
  await post('/api/player/resume');
  const s2 = await j('/api/state');
  ok('恢复播放正常', s2.current.paused === false);
}

console.log('\n== 六、点歌即预热 ==');
{
  await post('/api/queue/clear');
  const s0 = await j('/api/state');
  const curId = s0.current && s0.current.song.id;
  const target = pool.find((id) => id !== curId);
  const r = await post('/api/queue', { songId: target, by: 'prewarm' });
  ok('点歌成功', r.code === 200, r.error || '');
  let ready = false;
  let last = null;
  for (let i = 0; i < 40; i++) {
    const st = await j('/api/state');
    const q = st.queue.find((x) => x.song.id === target);
    last = q && q.prepare;
    if (q && q.prepare && (q.prepare.state === 'ready' || q.prepare.state === 'unsupported')) {
      ready = true;
      break;
    }
    await sleep(500);
  }
  ok('队列里的歌会被后台预处理', ready, JSON.stringify(last));
}

console.log('\n== 七、后台批量移除（不影响磁盘文件）==');
{
  const s0 = await j('/api/state');
  const curId = s0.current && s0.current.song.id;
  const list = await j('/api/songs?limit=30');
  const victim = list.items.find((s) => s.id !== curId);
  const before = list.total;
  const r = await post('/api/songs/batch', { ids: [victim.id], action: 'remove' });
  ok('移除成功', r.affected === 1, `affected=${r.affected}`);
  const s = await j(`/api/songs/${victim.id}`);
  ok('移除后查不到', s.code === 404, `code=${s.code}`);
  const cfg = await j('/api/settings');
  ok('黑名单已记录', cfg.removedCount >= 1, `removed=${cfg.removedCount}`);
  const back = await post('/api/songs/restore-removed');
  ok('可恢复', back.restored >= 1, `restored=${back.restored}`);
  const after = await j('/api/songs?limit=1');
  await rescan();
  const again = await j('/api/songs?limit=1');
  ok('恢复后重新扫描能收回', again.total === before, `before=${before} afterRemove=${after.total} afterRescan=${again.total}`);
}

console.log('\n== 八、重复点歌默认拦截 ==');
{
  // e2e-v2 结束时会把设置还原成测试前的值，这里显式打开
  await post('/api/settings', { noRepeat: true });
  await post('/api/queue/clear');
  if (!(await j('/api/state')).current) await post('/api/queue', { songId: pool[0], by: 'dup-base' });
  const st = await j('/api/state');
  const cur = st.current;
  if (cur) {
    const r = await post('/api/queue', { songId: cur.song.id, by: 'dup' });
    ok('正在唱的歌不能重复点', r.code === 409, r.error || `code=${r.code}`);
    const q = await post('/api/queue', { songId: pool[1] || cur.song.id, by: 'dup2' });
    const r2 = await post('/api/queue', { songId: pool[1] || cur.song.id, by: 'dup2' });
    ok('已在队列里的不能重复点', q.code === 200 ? r2.code === 409 : true, `${q.code}/${r2.code}`);
  } else {
    ok('（跳过）当前无歌曲', true);
  }
  await post('/api/queue/clear');
  await post('/api/settings', { noRepeat: true, prewarm: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
