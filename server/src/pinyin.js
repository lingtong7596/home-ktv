import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * 离线拼音：把汉字转成全拼 + 首字母。
 * 用于"输入 qbnm / qingbainianti"都能搜到歌名，这是 KTV 点歌的核心交互。
 */
let MAP = null;

function loadTable() {
  if (MAP) return MAP;
  MAP = new Map();
  // 词表随应用代码打包（src/），不走 data 目录（升级/清缓存不丢）
  const file = path.join(ROOT, 'src', 'pinyin-table.json');
  const legacy = path.join(ROOT, 'data', 'pinyin-table.json');
  const target = [file, legacy].find((f) => fs.existsSync(f));
  try {
    if (!target) throw new Error(`not found: ${file}`);
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const chars = raw.c;
    const pys = raw.p.split(',');
    for (let i = 0; i < chars.length; i++) MAP.set(chars[i], pys[i]);
  } catch (err) {
    console.warn('[pinyin] 词表缺失，拼音搜索将降级为仅中文匹配:', err.message);
  }
  return MAP;
}

const isAscii = (ch) => /[a-z0-9]/i.test(ch);

/**
 * @returns {{py:string, init:string}}  py=全拼（无分隔），init=首字母
 */
export function toPinyin(text) {
  const map = loadTable();
  let py = '';
  let init = '';
  for (const ch of String(text || '')) {
    if (isAscii(ch)) {
      py += ch.toLowerCase();
      if (/[a-z0-9]/i.test(ch)) init += ch.toLowerCase();
      continue;
    }
    const p = map.get(ch);
    if (p) {
      py += p;
      init += p[0];
    }
  }
  return { py, init };
}
