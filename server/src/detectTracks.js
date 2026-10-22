/**
 * 音轨顺序自动识别
 *
 * 为什么不做"逐首音频能量分析"：
 *   J1900 上解码 5000 首的音频特征需要几十小时，得不偿失。
 *   实际 KTV 片源里，音轨标题（title tag）几乎都写了"原唱/伴唱/伴奏"，
 *   命中率远高于成本。标题缺失时退回全局默认（0=原唱 1=伴唱），
 *   并允许后台对单曲一键对调。
 */

// 注意顺序：先判"伴唱"再判"原唱"，因为"伴唱"也含"唱"字
const ACC_WORDS = [
  '伴唱', '伴奏', '卡拉', 'karaoke', 'instrumental', 'backing', 'acc',
  '演奏', '纯音乐', '消音', '无人声',
];
const ORIG_WORDS = [
  '原唱', 'original', 'vocal', '人声', '演唱', '歌曲', 'vox', '唱',
];

function classify(title) {
  const t = String(title || '').toLowerCase().trim();
  if (!t) return '';
  if (ACC_WORDS.some((w) => t.includes(w))) return 'acc';
  if (ORIG_WORDS.some((w) => t.includes(w))) return 'orig';
  return '';
}

/**
 * @param {Array<{i:number,title?:string,lang?:string,channels?:number}>} audios
 * @returns {{orig:number|null, acc:number|null, reason:string}}
 *   orig/acc 为 null 表示"无法确定，请用全局默认"
 */
export function detectTracks(audios) {
  if (!Array.isArray(audios) || !audios.length) {
    return { orig: null, acc: null, reason: 'no-audio' };
  }
  if (audios.length === 1) {
    // 单音轨：无法切原伴唱，交给播放端按"仅一种音轨"处理
    return { orig: null, acc: null, reason: 'single-track' };
  }

  const kinds = audios.map((a) => classify(a.title));
  const origIdx = kinds.indexOf('orig');
  const accIdx = kinds.indexOf('acc');

  if (origIdx >= 0 && accIdx >= 0 && origIdx !== accIdx) {
    return { orig: origIdx, acc: accIdx, reason: `title:${audios[origIdx].title}|${audios[accIdx].title}` };
  }

  // 只识别出一条时，另一条取"另一条音轨"（双音轨场景最常见）
  if (audios.length === 2) {
    if (origIdx >= 0 && accIdx < 0) {
      return { orig: origIdx, acc: 1 - origIdx, reason: `title-partial:${audios[origIdx].title}` };
    }
    if (accIdx >= 0 && origIdx < 0) {
      return { orig: 1 - accIdx, acc: accIdx, reason: `title-partial:${audios[accIdx].title}` };
    }
  }

  return { orig: null, acc: null, reason: 'unknown' };
}
