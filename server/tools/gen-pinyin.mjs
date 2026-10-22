// 开发期脚本：用 pinyin-pro 生成离线的汉字->拼音表，供 NAS 端零依赖查表
import { pinyin } from 'pinyin-pro';
import { writeFileSync } from 'node:fs';

const chars = [];
const pys = [];
for (let cp = 0x4e00; cp <= 0x9fff; cp++) {
  const ch = String.fromCharCode(cp);
  let py = '';
  try {
    const arr = pinyin(ch, { toneType: 'none', type: 'array', nonZh: 'removed' });
    py = (arr && arr[0]) || '';
  } catch {
    py = '';
  }
  if (!py || !/^[a-z]+$/.test(py)) continue;
  chars.push(ch);
  pys.push(py);
}

const out = { c: chars.join(''), p: pys.join(',') };
// 词表随代码打包（src/），避免放在 data/ 被清理或升级时丢失
const path = 'new URL("../src/pinyin-table.json", import.meta.url).pathname';
writeFileSync(path, JSON.stringify(out), 'utf8');
console.log('chars:', chars.length, 'size:', (JSON.stringify(out).length / 1024).toFixed(0) + 'KB');
console.log('samples:', ['歌', '爱', '情', '人', '周', '杰', '伦'].map((c) => c + '=' + pinyin(c, { toneType: 'none' })).join(' '));
