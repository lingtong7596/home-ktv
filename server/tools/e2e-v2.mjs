/**
 * v2 新接口端到端验收：快速扫描 / 歌星 / 收藏 / 停用 / 编辑 / 头像 / 设置 / 自动播放 / 随机
 * 前置：服务已在本机 9188 运行（test-media 曲库）
 */
const base = 'http://127.0.0.1:9188';
let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✔ ${name}`);
  } else {
    fail++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const j = async (p, o) => {
  const r = await fetch(base + p, o);
  return { code: r.status, data: await r.json().catch(() => ({})) };
};
const post = (p, body, headers) =>
  j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body || {}) });

// 重置运行态，保证脚本可反复跑：清队列 / 清收藏 / 关自动播放
await post('/api/queue/clear', {});
await post('/api/favs/clear', {});
await post('/api/settings', { autoplayMode: 'off', noRepeat: false });

console.log('== 一、快速扫描（不读音轨） ==');
{
  const t0 = Date.now();
  const r = await post('/api/scan', { filenameOrder: 'artist-title', deepScan: false });
  ok('扫描可启动', r.data.started === true, JSON.stringify(r.data));
  await new Promise((res) => setTimeout(res, 2500));
  const st = await j('/api/scan/status');
  ok('扫描完成', st.data.progress.phase === 'done' || !st.data.running, st.data.progress.message);
  const songs = await j('/api/songs?limit=100');
  ok('歌曲已入库', songs.data.total >= 5, `total=${songs.data.total}`);
  const noDur = songs.data.items.every((s) => s.duration === 0 || s.duration > 0);
  ok('快速模式不阻塞（<10s）', Date.now() - t0 < 10000);
  const artists = await j('/api/artists');
  ok('歌手聚合生成', artists.data.total >= 3, `total=${artists.data.total}`);
  const zjl = artists.data.items.find((a) => a.name.includes('周杰伦'));
  ok('歌手含歌曲数', zjl && zjl.count >= 1);
}

console.log('== 二、懒探测（首次点唱补读音轨） ==');
{
  const songs = await j('/api/songs?q=qingtian');
  const s = songs.data.items[0];
  ok('晴天可查到', !!s, JSON.stringify(songs.data.total));
  const cached = (s.trackCount | 0) > 0; // 重复跑脚本时音轨已落库，属正常
  const t0 = Date.now();
  const d = await j(`/api/songs/${s.id}?probe=1`);
  ok(cached ? '音轨已缓存（跳过首次探测）' : '懒探测补齐音轨', d.data.trackCount === 2, `trackCount=${d.data.trackCount}`);
  ok('音轨标题识别', (d.data.audios || []).some((a) => a.title === '原唱'), JSON.stringify(d.data.audios));
  console.log(`     懒探测耗时 ${Date.now() - t0}ms（单文件文件头）`);
}

console.log('== 三、收藏 ==');
{
  const songs = await j('/api/songs?q=qingtian');
  const id = songs.data.items[0].id;
  let r = await post('/api/favs/toggle', { songId: id });
  ok('收藏成功', r.data.fav === true);
  const list = await j('/api/favs');
  ok('收藏列表含该曲', list.data.items.some((x) => x.id === id));
  r = await post('/api/favs/toggle', { songId: id });
  ok('取消收藏', r.data.fav === false);
  await post('/api/favs/toggle', { songId: id }); // 留一首收藏
}

console.log('== 四、停用 / 编辑 ==');
{
  const songs = await j('/api/songs?q=liang');
  const s = songs.data.items[0];
  let r = await post(`/api/songs/${s.id}/disable`, { disabled: true });
  ok('停用成功', r.data.ok);
  const after = await j('/api/songs?q=liang');
  ok('停用后搜不到', !after.data.items.some((x) => x.id === s.id));
  r = await post(`/api/songs/${s.id}/disable`, { disabled: false });
  ok('重新启用', r.data.ok);
  r = await post(`/api/songs/${s.id}/edit`, { lang: '国语', type: '合唱' });
  ok('编辑保存', r.data.ok && r.data.song.lang === '国语');
}

console.log('== 五、歌手信息 / 头像 ==');
{
  const artists = await j('/api/artists?q=zjl');
  const a = artists.data.items[0];
  ok('拼音搜歌手', !!a && a.name === '周杰伦');
  let r = await post(`/api/artists/${a.id}`, { region: '台湾', gender: '男' });
  ok('地区性别保存', r.data.ok && r.data.artist.region === '台湾');
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  r = await j(`/api/artists/${a.id}/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: png,
  });
  ok('头像上传', r.data.ok && r.data.size === png.length);
  const img = await fetch(`${base}/api/artists/${a.id}/avatar`);
  ok('头像可访问', img.status === 200);
  const filtered = await j('/api/artists?region=台湾&gender=男');
  ok('按地区性别筛选', filtered.data.items.some((x) => x.id === a.id));
  const songsOf = await j('/api/artists/' + a.id);
  ok('歌手详情含歌曲', songsOf.data.songs.length >= 1);
}

console.log('== 六、设置 / 自动播放 / 随机 ==');
{
  let r = await post('/api/settings', { autoplayMode: 'random', noRepeat: true });
  ok('保存设置', r.data.ok);
  const st = await j('/api/settings');
  ok('设置已生效', st.data.autoplayMode === 'random' && st.data.noRepeat === true);

  r = await post('/api/queue', { songId: (await j('/api/songs?q=qingtian')).data.items[0].id, by: 't' });
  ok('点歌即播', r.data.started === true || r.data.position > 0, JSON.stringify(r.data).slice(0, 80));
  const dup = await post('/api/queue', { songId: (await j('/api/songs?q=qingtian')).data.items[0].id, by: 't' });
  ok('禁止重复点歌（409）', dup.code === 409, `code=${dup.code}`);

  await post('/api/queue/clear', {}); // 队列清空才算「空闲」，否则 next 会播队列里的歌
  await post('/api/player/next');
  await new Promise((res) => setTimeout(res, 6500));
  const state = await j('/api/state');
  ok('空闲自动播放接管', state.data.current && state.data.current.by === '自动播放', JSON.stringify(state.data.current && state.data.current.by));

  const rnd = await j('/api/random?n=3');
  ok('随机推荐', rnd.data.items.length >= 1);
  const rndFav = await j('/api/random?n=1&from=favs');
  ok('收藏随机', rndFav.data.items.length >= 1);

  r = await post('/api/settings', { autoplayMode: 'off', noRepeat: false });
  ok('还原设置', r.data.ok);
}

console.log('== 七、重唱 ==');
{
  const st = await j('/api/state');
  if (st.data.current) {
    const r = await post('/api/player/replay');
    ok('重唱成功', r.data.ok);
  } else {
    ok('重唱（无歌曲时跳过）', true);
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
