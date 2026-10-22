import path from 'node:path';

/**
 * 文件名解析（按用户实测的曲库规范定制）
 *
 * 规范：  歌手文件夹 / 歌手-歌名-语种-类型.ext
 * 示例：  周杰伦/周杰伦-爱情悬崖-国语-流行.mkv
 *         白冰 胡歌/白冰 胡歌-美丽的神话-国语-合唱.mpg
 *         单依纯_VaVa毛衍七_吴宣仪_群星/单依纯_VaVa毛衍七_吴宣仪_群星-VVS-国语-合唱.mkv
 *
 * 核心难点与对策：
 *  1. 歌名自带 "-"（如 "十年-粤语版"）→ 不按固定位置切，而是"从尾部反向识别语种/类型"，
 *     只有落在词表里的片段才被摘掉，剩下的中间部分整体作为歌名，不会被切碎。
 *  2. 多歌手写法混乱（& _ 空格）→ 拆别名做搜索，但保留全称做展示。
 *  3. 老式命名（001.七里香-国语 / 周杰伦 - 晴天 / [国语]周杰伦-晴天）→ 一并兼容。
 */

/* ---------------- 词表 ---------------- */

// 语种（精确归一后匹配）
const LANG_ALIAS = new Map([
  ['国语', '国语'], ['华语', '国语'], ['普通话', '国语'], ['中文', '国语'], ['汉语', '国语'],
  ['mandarin', '国语'], ['chinese', '国语'], ['cn', '国语'], ['ch', '国语'],
  ['粤语', '粤语'], ['广东话', '粤语'], ['cantonese', '粤语'], ['粤', '粤语'],
  ['闽南语', '闽南语'], ['台语', '闽南语'], ['闽南', '闽南语'], ['hokkien', '闽南语'],
  ['客家话', '客家话'], ['客家语', '客家话'],
  ['英语', '英语'], ['英文', '英语'], ['english', '英语'], ['en', '英语'],
  ['日语', '日语'], ['日文', '日语'], ['japanese', '日语'], ['jp', '日语'],
  ['韩语', '韩语'], ['韩文', '韩语'], ['朝鲜语', '韩语'], ['korean', '韩语'], ['kr', '韩语'],
  ['法语', '法语'], ['德语', '德语'], ['俄语', '俄语'], ['西班牙语', '西班牙语'],
  ['意大利语', '意大利语'], ['葡萄牙语', '葡萄牙语'], ['泰语', '泰语'], ['越南语', '越南语'],
  ['印尼语', '印尼语'], ['阿拉伯语', '阿拉伯语'],
  ['上海话', '上海话'], ['四川话', '四川话'], ['东北话', '东北话'], ['湖南话', '湖南话'],
  ['藏语', '藏语'], ['蒙语', '蒙语'], ['维吾尔语', '维吾尔语'],
]);

// 类型 / 风格（位于文件名最末尾）
const TYPE_ALIAS = new Map([
  ['流行', '流行'], ['pop', '流行'],
  ['合唱', '合唱'], ['对唱', '对唱'], ['重唱', '重唱'], ['群唱', '合唱'],
  ['摇滚', '摇滚'], ['rock', '摇滚'], ['民谣', '民谣'], ['folk', '民谣'],
  ['美声', '美声'], ['民族', '民族'], ['民歌', '民歌'], ['通俗', '流行'],
  ['儿歌', '儿歌'], ['童谣', '儿歌'], ['少儿', '儿歌'],
  ['戏曲', '戏曲'], ['京剧', '戏曲'], ['越剧', '戏曲'], ['黄梅戏', '戏曲'],
  ['豫剧', '戏曲'], ['粤剧', '戏曲'], ['昆曲', '戏曲'], ['评剧', '戏曲'],
  ['相声', '曲艺'], ['小品', '曲艺'], ['朗诵', '朗诵'],
  ['爵士', '爵士'], ['jazz', '爵士'], ['蓝调', '蓝调'], ['blues', '蓝调'],
  ['说唱', '说唱'], ['嘻哈', '说唱'], ['rap', '说唱'], ['rnb', 'R&B'], ['r&b', 'R&B'],
  ['古风', '古风'], ['中国风', '中国风'], ['国风', '古风'],
  ['舞曲', '舞曲'], ['dj', 'DJ'], ['disco', '舞曲'],
  ['轻音乐', '轻音乐'], ['纯音乐', '纯音乐'], ['器乐', '纯音乐'], ['乐器', '纯音乐'],
  ['情歌', '情歌'], ['伤感', '伤感'], ['网络', '网络歌曲'], ['网络歌曲', '网络歌曲'],
  ['经典', '经典'], ['老歌', '经典'], ['红歌', '红歌'], ['军旅', '军旅'],
  ['广场舞', '广场舞'], ['宗教', '宗教'], ['仪式', '仪式'],
]);

// 纯噪声片段（出现即丢弃，不影响结构）
const NOISE = new Set([
  '1080p', '1080i', '720p', '480p', '2160p', '4k', '8k', 'uhd', 'hd', 'fhd',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'aac', 'ac3', 'dts', 'flac', 'mp3',
  'bluray', 'blu-ray', 'web-dl', 'remux', '10bit', '8bit', 'hdr', 'sdr',
  '高清', '超清', '蓝光', '完整版', '修复版', '珍藏版', '演唱会', '现场版',
  'mv', 'mtv', 'ktv', '卡拉ok', 'karaoke', '官方版', '高清版', '带字幕', '中字',
  '双音轨', '双声道', '多音轨', 'vcd', 'dvd', '原唱', '伴唱', '伴奏', '伴奏版',
]);

// 通用目录名（不能当歌手）
const GENERIC_DIRS = new Set([
  'ktv', 'mv', 'mtv', '歌曲', '音乐', '曲库', '视频', '点歌', '卡拉ok', 'karaoke',
  'ktv曲库', 'ktv歌库', '歌库', '新建文件夹', 'downloads', 'download', 'media',
  'video', 'videos', 'movie', 'movies', '其他', '未分类', '整理', '备份',
  '115open', 'cd2', 'netdisk', 'vol1', 'volume1', 'nas', '共享', '影视',
]);

/* ---------------- 工具 ---------------- */

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
const clean = (s) =>
  String(s || '')
    .replace(/^[\s\-－–—_.,，、:：]+/, '')
    .replace(/[\s\-－–—_.,，、:：]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

function lookup(map, token) {
  const t = norm(token);
  if (!t) return '';
  return map.get(t) || '';
}

/** 多歌手拆分：& _ / 、 , 空格（空格仅在"每段都是 2-4 字中文"时拆，保护英文名） */
export function splitArtists(name) {
  const raw = clean(name);
  if (!raw) return [];

  let segs = raw.split(/\s*[&＆_\/、,，]\s*/).map(clean).filter(Boolean);

  if (segs.length === 1 && /\s/.test(raw)) {
    const sp = raw.split(/\s+/).map(clean).filter(Boolean);
    const allChineseShort = sp.every((s) => /^[\u4e00-\u9fa5]{2,4}$/.test(s));
    if (sp.length >= 2 && allChineseShort) segs = sp;
  }
  return segs.length ? segs : [raw];
}

/* ---------------- 主解析 ---------------- */

/**
 * @param {string} filePath 完整路径
 * @param {{filenameOrder?: 'artist-title'|'title-artist', rootDir?: string}} opts
 * @returns {{title:string, artist:string, lang:string, type:string,
 *            artists:string[], folder:string, raw:string}}
 */
export function parseMediaName(filePath, { filenameOrder = 'artist-title', rootDir = '' } = {}) {
  const ext = path.extname(filePath);
  const raw = path.basename(filePath, ext);
  const folder = clean(path.basename(path.dirname(filePath)));

  let work = raw;

  /* 1. 先摘出括号里的语种/类型线索，并去掉纯噪声括号 */
  let lang = '';
  let type = '';
  const bracketHits = [...work.matchAll(/[\[\(【（]([^\]\)】）]*)[\]\)】）]/g)].map((m) => m[1]);
  work = work.replace(/[\[\(【（]([^\]\)】）]*)[\]\)】）]/g, (whole, inner) => {
    const token = clean(inner);
    if (!token) return ' ';
    const l = lookup(LANG_ALIAS, token);
    const t = lookup(TYPE_ALIAS, token);
    if (l) { lang = lang || l; return ' '; }
    if (t) { type = type || t; return ' '; }
    if (NOISE.has(norm(token))) return ' ';
    return ` ${token} `;
  });

  /* 2. 书名号 → 分隔符：《晴天》→ -晴天- */
  work = work.replace(/《([^》]*)》/g, ' - $1 - ');

  /* 3. 去掉开头序号：001. / 01、 / 12_ */
  work = work.replace(/^\s*\d{1,4}\s*[.、_]\s*/, '');

  /* 4. 按连字符切分（半角 + 全角） */
  let parts = work
    .split(/\s*[-－–—]\s*/)
    .map(clean)
    .filter(Boolean);

  /* 5. 丢弃纯噪声片段（如 1080P、MV） */
  parts = parts.filter((p) => !NOISE.has(norm(p)));

  /* 6. 从尾部反向识别：类型 → 语种（这样"歌名里的 -"不会被误切） */
  const popTail = (map) => {
    if (parts.length < 2) return '';
    const hit = lookup(map, parts[parts.length - 1]);
    if (hit) { parts.pop(); return hit; }
    return '';
  };

  if (!type) type = popTail(TYPE_ALIAS);
  if (!lang) lang = popTail(LANG_ALIAS);
  // 再试一次：有些库是 歌手-歌名-类型（无语种）
  if (!type) type = popTail(TYPE_ALIAS);

  /* 7. 拆歌手 / 歌名 */
  let artist = '';
  let title = '';

  if (parts.length >= 2) {
    if (filenameOrder === 'title-artist') {
      title = parts[0];
      artist = parts.slice(1).join('-');
    } else {
      artist = parts[0];
      title = parts.slice(1).join('-');
    }
  } else if (parts.length === 1) {
    title = parts[0];
    // 歌手回退取上级文件夹（排除通用目录名）
    if (folder && !isGenericDir(folder) && folder !== clean(path.basename(rootDir || ''))) {
      artist = folder;
    }
  }

  // 歌手段若本身是语种/类型（说明该库是"歌名-国语-流行"结构），把它退回歌名
  if (artist && (lookup(LANG_ALIAS, artist) || lookup(TYPE_ALIAS, artist))) {
    title = clean([artist, title].filter(Boolean).join('-'));
    artist = folder && !isGenericDir(folder) ? folder : '';
  }

  title = clean(title) || clean(raw);
  artist = clean(artist) || '未知歌手';

  /* 多歌手统一分隔符：`老狼&痛仰乐队` / `白冰 胡歌` / `A_B_C` 全部归一为 ` & ` 连接，
     既保证列表显示整齐，也让搜索能按单个歌手名命中。 */
  const artists = splitArtists(artist);
  if (artists.length > 1) artist = artists.join(' & ');

  /* 8. 语种/类型兜底：从标题里再找一次（如 "晴天 国语版"） */
  if (!lang) {
    for (const [alias, canon] of LANG_ALIAS) {
      if (norm(title).endsWith(alias) && alias.length >= 2) { lang = canon; break; }
    }
  }

  return {
    title,
    artist,
    lang,
    type,
    artists,
    folder,
    raw,
  };
}

function isGenericDir(name) {
  return GENERIC_DIRS.has(norm(name));
}

/** 兼容旧接口 */
export function looksLikeSingleToken(name) {
  return !/[-\s_、]/.test(name);
}
