/**
 * SQLite 曲库层实测：5000 首规模下的写入、重扫、检索、用户数据保留
 * 运行：node tools/test-db.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSongStore } from '../src/db.js';
import { parseMediaName } from '../src/parse.js';
import { toPinyin } from '../src/pinyin.js';

const ROOT = '/vol1/1000/ktv歌库';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktvdb-'));
const store = openSongStore(tmp);

const ARTISTS = ['周杰伦', '陈奕迅', '林俊杰', '邓紫棋', '薛之谦', '张学友', '刘德华', '王菲', '毛不易', '李荣浩',
  '老狼&痛仰乐队', '白冰 胡歌', '凤凰传奇', '单依纯_VaVa毛衍七_吴宣仪_群星', 'Taylor Swift', '五月天', 'Beyond'];
const TITLES = ['晴天', '十年', '江南', '泡沫', '演员', '吻别', '忘情水', '红豆', '消愁', '李白',
  '爱情悬崖', '一个人的冬天', '美丽的神话', '最炫民族风', 'VVS', 'Love Story', '倔强', '海阔天空',
  '三年二班', '七里香', '青花瓷', '夜曲', '稻香', '告白气球', '孤勇者', '起风了', '漠河舞厅'];
const LANGS = ['国语', '粤语', '英语', '日语', '韩语'];
const TYPES = ['流行', '合唱', '对唱', '摇滚', '民谣', '经典'];

const pick = (arr, i) => arr[i % arr.length];
const pad = (n) => String(n).padStart(5, '0');

function makeSongs(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const artist = pick(ARTISTS, i);
    const title = `${pick(TITLES, i)}${i >= TITLES.length ? ` ${pad(i)}` : ''}`;
    const lang = pick(LANGS, i);
    const type = pick(TYPES, i);
    const file = `${ROOT}/${artist}/${artist}-${title}-${lang}-${type}.mkv`;
    const parsed = parseMediaName(file, { rootDir: ROOT });
    const tPy = toPinyin(parsed.title);
    const aPy = toPinyin(parsed.artist);
    out.push({
      id: `id${pad(i)}`,
      file,
      rel: `${artist}/${path.basename(file)}`,
      dir: `${ROOT}/${artist}`,
      name: path.basename(file, '.mkv'),
      title: parsed.title,
      artist: parsed.artist,
      artists: parsed.artists,
      lang: parsed.lang,
      type: parsed.type,
      duration: 200 + (i % 120),
      width: 1920,
      height: 1080,
      vcodec: i % 3 === 0 ? 'hevc' : 'h264',
      audios: [
        { i: 0, codec: 'aac', channels: 2, title: '原唱', lang: 'chi' },
        { i: 1, codec: 'aac', channels: 2, title: '伴唱', lang: 'chi' },
      ],
      trackCount: 2,
      size: 80 * 1024 * 1024,
      mtime: 1700000000000 + i,
      py: tPy.py,
      init: tPy.init,
      apy: aPy.py,
      ainit: aPy.init,
      pinit: aPy.init + tPy.init,
      plays: 0,
      lastPlayed: 0,
      addedAt: Date.now(),
      origTrack: 0,
      accTrack: 1,
      probeOk: true,
      trackGuess: 'title:原唱|伴唱',
    });
  }
  return out;
}

const ms = (t) => `${t.toFixed(0)} ms`;
const line = (label, t, extra = '') => console.log(`| ${label} | ${ms(t)} | ${extra} |`);

console.log('\n### 一、5000 首写入与增量重扫\n');
console.log('| 操作 | 耗时 | 结果 |');
console.log('|---|---|---|');

const songs = makeSongs(5000);

let t = performance.now();
let r1 = store.upsertScan(songs);
let tWrite = performance.now() - t;
line('首次写入 5000 首', tWrite, `新增 ${r1.inserted}，更新 ${r1.updated}`);

t = performance.now();
const all = store.all();
let tRead = performance.now() - t;
line('全量读出', tRead, `${all.length} 行`);

t = performance.now();
let r2 = store.upsertScan(songs);
let tRescan = performance.now() - t;
line('原样重扫（增量）', tRescan, `新增 ${r2.inserted}，更新 ${r2.updated}，删除 ${r2.removed}`);

console.log('\n### 二、用户数据是否被重扫覆盖\n');
console.log('| 检查项 | 期望 | 实际 | 判定 |');
console.log('|---|---|---|---|');

store.incPlay('id00001');
store.incPlay('id00001');
store.incPlay('id00001');
store.setTrackOverride('id00002', 1, 0);

store.upsertScan(songs); // 模拟一次完整重扫

const a = store.get('id00001');
const b = store.get('id00002');
const c = store.get('id00003');
console.log(`| 点唱次数保留 | 3 | ${a.plays} | ${a.plays === 3 ? '✅' : '❌'} |`);
console.log(`| 最后点唱时间保留 | >0 | ${a.lastPlayed > 0 ? '有' : '无'} | ${a.lastPlayed > 0 ? '✅' : '❌'} |`);
console.log(`| 单曲音轨覆盖保留 | 1/0 | ${b.origTrack}/${b.accTrack} | ${b.origTrack === 1 && b.accTrack === 0 ? '✅' : '❌'} |`);
console.log(`| 未操作曲目音轨默认 | 0/1 | ${c.origTrack}/${c.accTrack} | ${c.origTrack === 0 && c.accTrack === 1 ? '✅' : '❌'} |`);

console.log('\n### 三、删除已消失的文件\n');
const removedList = songs.slice(0, 120);
const remain = songs.slice(120);
const r3 = store.upsertScan(remain);
console.log('| 操作 | 期望删除 | 实际删除 | 剩余 | 判定 |');
console.log('|---|---|---|---|---|');
console.log(`| 曲库减少 120 首后重扫 | 120 | ${r3.removed} | ${store.count()} | ${r3.removed === 120 && store.count() === remain.length ? '✅' : '❌'} |`);

console.log('\n### 四、真实文件名入库校验（你那 7 个样本）\n');
const realSamples = [
  `${ROOT}/周杰伦/周杰伦-爱情悬崖-国语-流行.mkv`,
  `${ROOT}/安七炫/安七炫-面具-国语-流行.mkv`,
  `${ROOT}/爱乐团/爱乐团-天涯-国语-流行.mkv`,
  `${ROOT}/陈楚生/陈楚生-一个人的冬天-国语-流行.mkv`,
  `${ROOT}/老狼&痛仰乐队/老狼&痛仰乐队-迪亚-国语-流行.mkv`,
  `${ROOT}/白冰 胡歌/白冰 胡歌-美丽的神话-国语-合唱.mpg`,
  `${ROOT}/单依纯_VaVa毛衍七_吴宣仪_群星/单依纯_VaVa毛衍七_吴宣仪_群星-VVS-国语-合唱.mkv`,
];

const realTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ktvreal-'));
const realStore = openSongStore(realTmp);
const realSongs = realSamples.map((file, i) => {
  const p = parseMediaName(file, { rootDir: ROOT });
  const tPy = toPinyin(p.title);
  const aPy = toPinyin(p.artist);
  return {
    id: `real${i}`, file, rel: file.slice(ROOT.length + 1), dir: path.dirname(file),
    name: p.raw, title: p.title, artist: p.artist, artists: p.artists, lang: p.lang, type: p.type,
    duration: 240, width: 1920, height: 1080, vcodec: 'h264',
    audios: [{ i: 0, title: '原唱' }, { i: 1, title: '伴唱' }],
    trackCount: 2, size: 1000, mtime: Date.now(),
    py: tPy.py, init: tPy.init, apy: aPy.py, ainit: aPy.init, pinit: aPy.init + tPy.init,
    plays: 0, lastPlayed: 0, addedAt: Date.now(), origTrack: 0, accTrack: 1, probeOk: true,
  };
});
realStore.upsertScan(realSongs);

console.log('| 歌手 | 歌名 | 语种 | 类型 | 别名 | 拼音首字母 |');
console.log('|---|---|---|---|---|---|');
for (const s of realStore.all().sort((x, y) => x.file.localeCompare(y.file))) {
  console.log(`| ${s.artist} | ${s.title} | ${s.lang} | ${s.type} | ${s.artists.join(' / ')} | \`${s.pinit}\` |`);
}

console.log('\n### 五、检索性能（5000 首内存索引）\n');
const { Library } = await import('../src/library.js');

// 用真实 Library 跑搜索：直接注入内存数据，避开磁盘
const lib = Object.create(Library.prototype);
lib.songs = store.all().concat();
lib.byIdMap = new Map(lib.songs.map((s) => [s.id, s]));
lib.store = store;
lib.cfg = {};
lib.updatedAt = Date.now();

const queries = ['zjl', 'zjlaqxy', 'aqx', '晴天', '老狼', 'mldsh', 'VVS', 'love'];
console.log('| 查询 | 命中 | 耗时 | 首条结果 |');
console.log('|---|---|---|---|');
for (const q of queries) {
  const t0 = performance.now();
  const res = lib.search(q, { limit: 20 });
  const dt = performance.now() - t0;
  const first = res.items[0] ? `${res.items[0].artist} - ${res.items[0].title}` : '（无）';
  console.log(`| \`${q}\` | ${res.total} | ${dt.toFixed(1)} ms | ${first} |`);
}

console.log('\n### 六、类型筛选（对唱/合唱）\n');
const duet = lib.search('', { type: '合唱', limit: 5 });
console.log(`类型=合唱 共 **${duet.total}** 首，前 3 首：${duet.items.slice(0, 3).map((s) => s.title).join('、') || '无'}`);
const langFacets = lib.langFacets();
const typeFacets = lib.typeFacets();
console.log(`语种分布：${langFacets.map((x) => `${x.lang} ${x.count}`).join(' / ')}`);
console.log(`类型分布：${typeFacets.map((x) => `${x.type} ${x.count}`).join(' / ')}`);

const dbFile = path.join(tmp, 'ktv.db');
const dbSizeKB = fs.existsSync(dbFile) ? (fs.statSync(dbFile).size / 1024).toFixed(0) : '?';
store.close();
realStore.close();
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(realTmp, { recursive: true, force: true });
console.log(`\n5000 首的数据库文件大小：约 **${dbSizeKB} KB**（临时文件已清理）`);
