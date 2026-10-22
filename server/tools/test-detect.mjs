/**
 * 音轨自动识别用例
 * 运行：node tools/test-detect.mjs
 */
import { detectTracks } from '../src/detectTracks.js';

const cases = [
  {
    name: '标准双音轨（原唱在前）',
    audios: [{ i: 0, title: '原唱' }, { i: 1, title: '伴唱' }],
    want: { orig: 0, acc: 1 },
  },
  {
    name: '标准双音轨（伴唱在前）',
    audios: [{ i: 0, title: '伴唱' }, { i: 1, title: '原唱' }],
    want: { orig: 1, acc: 0 },
  },
  {
    name: '英文标题',
    audios: [{ i: 0, title: 'Original Vocal' }, { i: 1, title: 'Karaoke' }],
    want: { orig: 0, acc: 1 },
  },
  {
    name: '中文"伴奏"写法',
    audios: [{ i: 0, title: '歌曲' }, { i: 1, title: '伴奏' }],
    want: { orig: 0, acc: 1 },
  },
  {
    name: '只标了伴唱（另一条推断为原唱）',
    audios: [{ i: 0, title: '' }, { i: 1, title: '伴唱' }],
    want: { orig: 0, acc: 1 },
  },
  {
    name: '三条音轨（原唱/伴唱/伴奏）',
    audios: [{ i: 0, title: '原唱' }, { i: 1, title: '伴唱' }, { i: 2, title: '伴奏' }],
    want: { orig: 0, acc: 1 },
  },
  {
    name: '标题缺失（交回全局默认）',
    audios: [{ i: 0, title: '' }, { i: 1, title: '' }],
    want: { orig: null, acc: null },
  },
  {
    name: '单音轨',
    audios: [{ i: 0, title: '' }],
    want: { orig: null, acc: null },
  },
  {
    name: '无音轨',
    audios: [],
    want: { orig: null, acc: null },
  },
];

console.log('\n| 场景 | 期望 | 实际 | 依据 | 判定 |');
console.log('|---|---|---|---|---|');
let pass = 0;
for (const c of cases) {
  const r = detectTracks(c.audios);
  const ok = r.orig === c.want.orig && r.acc === c.want.acc;
  if (ok) pass++;
  const fmt = (o, a) => `${o === null ? '默认' : o}/${a === null ? '默认' : a}`;
  console.log(`| ${c.name} | ${fmt(c.want.orig, c.want.acc)} | ${fmt(r.orig, r.acc)} | \`${r.reason}\` | ${ok ? '✅' : '❌'} |`);
}

console.log(`\n通过 **${pass}/${cases.length}**。`);
console.log('\n说明：识别不出来时返回 null，播放端使用全局默认（0=原唱/1=伴唱），后台可对单曲一键对调。');
process.exit(pass === cases.length ? 0 : 1);
