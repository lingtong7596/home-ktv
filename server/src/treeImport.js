import path from 'node:path';
import { parseMediaName } from './parse.js';
import { toPinyin } from './pinyin.js';
import { shortHash, log } from './util.js';

/**
 * 目录树导入：把 115/阿里云盘等网盘导出的目录树文本，
 * 离线解析成曲库条目直接入库（不需要真实文件在线）。
 *
 * 典型目录树格式（每行）：
 *   |——根目录
 *   | |-ktv歌库
 *   | | |-周杰伦
 *   | | | |-周杰伦-晴天-国语-流行.mkv
 *
 * 规则：
 *  - 深度 = 行内 '|' 的个数；名字 = 最后一个 '|-'（或 '|——'）之后的内容
 *  - 视频文件按 baseDir + 相对路径入库，ID 与真实扫描一致（路径短哈希），
 *    之后网盘挂载好了再全量扫描，同一路径会命中同一行，不会重复
 *  - 解析复用 parseMediaName，与扫描器完全一致（从尾部识别语种/类型）
 */

/** 解析目录树文本 → 有序列表 [{depth, name}] */
export function parseTreeLines(text) {
  const nodes = [];
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const idx = Math.max(line.lastIndexOf('|-'), line.lastIndexOf('|—'));
    if (idx < 0) continue; // 非目录树行（说明文字等）直接忽略
    const depth = (line.slice(0, idx).match(/\|/g) || []).length;
    const name = line.slice(idx + 2).trim();
    if (!name) continue;
    // 目录树制图符可能画成 "|——"（长横线），去掉多余的前导横线
    nodes.push({ depth, name: name.replace(/^—+/, '') });
  }
  return nodes;
}

/**
 * 目录树导入主入口。
 * @returns {{ songs: Array, artists: Array, files: number, anchor: string, anchorNote: string }}
 */
export function importFromTree({ cfg, baseDir, treeText }) {
  const videoExts = cfg.videoExts;
  const nodes = parseTreeLines(treeText);
  if (!nodes.length) throw new Error('目录树内容为空或格式不对：每行应形如 | | |-名字');

  const baseName = baseDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  let anchorDepth = null;
  for (const n of nodes) {
    if (n.name === baseName) {
      anchorDepth = n.depth;
      break;
    }
  }
  // 找不到与目录同名的节点时，退化为从树根下开始（多数情况根目录=网盘根）
  const fallback = anchorDepth === null;
  const rootDepth = nodes[0].depth;
  if (fallback) anchorDepth = rootDepth;

  // 用深度栈还原每个文件相对 anchor 的路径
  const stack = [];
  const rels = [];
  for (const n of nodes) {
    stack.length = n.depth; // 截断到当前深度
    stack[n.depth] = n.name;
    const ext = path.extname(n.name).toLowerCase();
    if (!videoExts.includes(ext)) continue;
    if (n.depth <= anchorDepth) continue; // anchor 本身或其上层不可能是文件
    const rel = [...stack.slice(anchorDepth + 1, n.depth), n.name].join('/');
    rels.push({ rel, name: n.name });
  }

  const songs = [];
  const artistMap = new Map();
  const seen = new Set();
  for (const { rel, name } of rels) {
    const file = path.join(baseDir, rel);
    if (seen.has(file)) continue; // 同名同路径去重（目录树偶尔重复行）
    seen.add(file);

    const parsed = parseMediaName(file, { filenameOrder: cfg.filenameOrder, rootDir: baseDir });
    const tPy = toPinyin(parsed.title);
    const aPy = toPinyin(parsed.artist);

    for (const aname of parsed.artists && parsed.artists.length ? parsed.artists : [parsed.artist]) {
      if (!artistMap.has(aname)) {
        const py = toPinyin(aname);
        artistMap.set(aname, { id: shortHash(`artist:${aname}`, 12), name: aname, py: py.py, init: py.init, count: 0 });
      }
      artistMap.get(aname).count++;
    }

    songs.push({
      id: shortHash(file, 12),
      file,
      rel,
      dir: path.dirname(file),
      name: parsed.raw,
      title: parsed.title,
      artist: parsed.artist,
      artists: parsed.artists,
      lang: parsed.lang,
      type: parsed.type,
      // 网盘文件还不在本地：探测信息全部留空，首次点唱时再补读
      duration: 0,
      width: 0,
      height: 0,
      vcodec: '',
      audios: [],
      trackCount: 0,
      size: 0,
      mtime: 0,
      py: tPy.py,
      init: tPy.init,
      apy: aPy.py,
      ainit: aPy.init,
      pinit: aPy.init + tPy.init,
      plays: 0,
      lastPlayed: 0,
      addedAt: Date.now(),
      origTrack: null,
      accTrack: null,
      probeOk: false,
      trackGuess: '',
    });
  }

  log(`[tree-import] ${baseDir}：目录树 ${nodes.length} 节点 → 视频 ${rels.length} 个 → 入库 ${songs.length} 首（anchor=${fallback ? '树根(退化)' : baseName}）`);
  return {
    songs,
    artists: [...artistMap.values()],
    files: rels.length,
    anchor: fallback ? null : baseName,
    anchorNote: fallback
      ? `目录树里没找到与「${baseName}」同名的文件夹，已按树根目录对齐`
      : `已按目录树里的「${baseName}」文件夹对齐`,
  };
}
