import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseMediaName } from './parse.js';
import { detectTracks } from './detectTracks.js';
import { ffprobe } from './probe.js';
import { toPinyin } from './pinyin.js';
import { shortHash, pool, log } from './util.js';

/**
 * 扫描曲库：遍历目录 → 解析文件名 → ffprobe 提取音轨 → 输出索引
 *
 * 增量策略（针对网盘与弱 CPU 优化）：
 *   mtime + size 都没变且上次探测成功 → 跳过 ffprobe，直接复用库里的元信息。
 *   这样第二次以后重扫，5000 首只需几秒到几十秒（仅目录遍历开销）。
 *
 * 容错：
 *   ffprobe 失败（网盘超时等）**不丢弃该文件**，仍按文件名入库，
 *   标记 probeOk=false，播放器可直接播原文件，音轨信息延后补。
 */
export async function scanLibrary(cfg, { onProgress = () => {}, prevSongs = new Map(), skipFiles = null } = {}) {
  const started = Date.now();
  const files = [];

  onProgress({ phase: 'walk', done: 0, total: 0, message: '正在遍历目录…' });

  const walk = async (dir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (cfg.ignoreDirs.some((d) => entry.name.toLowerCase() === d.toLowerCase())) continue;
        if (entry.name.startsWith('.')) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        // 后台手动删除过的文件不再收录
        if (skipFiles && skipFiles.has(full)) continue;
        if (cfg.videoExts.includes(ext)) files.push(full);
      }
    }
    onProgress({ phase: 'walk', done: files.length, total: 0, message: `已发现 ${files.length} 个视频文件` });
  };

  for (const dir of cfg.mediaDirs) {
    if (!fs.existsSync(dir)) {
      log(`[scan] 目录不存在，跳过: ${dir}`);
      continue;
    }
    await walk(dir);
  }

  if (!files.length) {
    onProgress({ phase: 'done', done: 0, total: 0, message: '没有找到视频文件，请检查曲库目录' });
    return { version: 2, updatedAt: Date.now(), songs: [], stats: { total: 0, scanMs: Date.now() - started } };
  }

  const deepScan = !!cfg.deepScan;
  const concurrency = Math.max(1, Math.min(8, Number(cfg.probeConcurrency) || 4));
  let done = 0;
  let reused = 0;
  let failed = 0;
  const songs = [];
  const artistMap = new Map(); // name -> {id,name,py,init,count}

  onProgress({
    phase: 'scan',
    done: 0,
    total: files.length,
    message: deepScan ? '正在读取音轨信息…' : '快速扫描中（只解析文件名，不读音轨）…',
  });

  await pool(files, concurrency, async (file) => {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      done++;
      return;
    }

    const id = shortHash(file, 12);
    const prev = prevSongs.get(id);
    const mtime = Math.floor(stat.mtimeMs);

    const rootDir = cfg.mediaDirs.find((d) => file.startsWith(d)) || '';
    const parsed = parseMediaName(file, { filenameOrder: cfg.filenameOrder, rootDir });
    const rel = path.relative(rootDir || path.dirname(file), file).split(path.sep).join('/');

    /* ---------- 元信息：能复用就复用；快速扫描不做 ffprobe ---------- */
    const unchanged = !!(prev && prev.probeOk && prev.mtime === mtime && prev.size === stat.size);
    let info = prev && prev.probeOk
      ? {
          duration: prev.duration,
          width: prev.width,
          height: prev.height,
          vcodec: prev.vcodec,
          audios: prev.audios || [],
        }
      : null;
    let probeOk = !!(prev && prev.probeOk);

    if (unchanged) {
      reused++;
    } else if (deepScan) {
      const probed = await ffprobe(file, cfg.ffprobe, cfg.probeTimeout || 45000);
      if (probed) {
        info = probed;
        probeOk = true;
      } else {
        failed++;
      }
    }

    /* ---------- 音轨原唱/伴唱 ---------- */
    let origTrack = prev ? prev.origTrack ?? null : null;
    let accTrack = prev ? prev.accTrack ?? null : null;
    let trackGuess = prev && prev.trackGuess ? prev.trackGuess : '';

    if (probeOk && info && info.audios && info.audios.length) {
      const guess = detectTracks(info.audios);
      trackGuess = guess.reason;
      // 只有用户没手动指定过，才写入自动识别结果
      const userSet = prev && (prev.origTrack != null || prev.accTrack != null);
      if (!userSet && guess.orig != null && guess.acc != null) {
        origTrack = guess.orig;
        accTrack = guess.acc;
      }
    }

    const tPy = toPinyin(parsed.title);
    const aPy = toPinyin(parsed.artist);

    // 歌手聚合（显示名 → 拼音/首字母/歌曲数）；多歌手各自建条目
    for (const name of parsed.artists && parsed.artists.length ? parsed.artists : [parsed.artist]) {
      const py = toPinyin(name);
      const key = name;
      if (!artistMap.has(key)) {
        artistMap.set(key, {
          id: shortHash(`artist:${name}`, 12),
          name,
          py: py.py,
          init: py.init,
          count: 0,
        });
      }
      artistMap.get(key).count++;
    }

    songs.push({
      id,
      file,
      rel,
      dir: path.dirname(file),
      name: parsed.raw,
      title: parsed.title,
      artist: parsed.artist,
      artists: parsed.artists,
      lang: parsed.lang,
      type: parsed.type,
      duration: info ? Math.round(info.duration || 0) : 0,
      width: info ? info.width || 0 : 0,
      height: info ? info.height || 0 : 0,
      vcodec: info ? info.vcodec || '' : '',
      audios: info ? info.audios || [] : [],
      trackCount: info ? (info.audios || []).length : 0,
      size: stat.size,
      mtime,
      py: tPy.py,
      init: tPy.init,
      apy: aPy.py,
      ainit: aPy.init,
      // 歌手+歌名连写首字母，支持 "zjlqt" 直达《周杰伦-晴天》
      pinit: aPy.init + tPy.init,
      plays: prev ? prev.plays || 0 : 0,
      lastPlayed: prev ? prev.lastPlayed || 0 : 0,
      addedAt: prev ? prev.addedAt || Date.now() : Date.now(),
      origTrack,
      accTrack,
      probeOk,
      trackGuess,
    });

    done++;
    onProgress({
      phase: 'scan',
      done,
      total: files.length,
      // 实时显示当前处理的文件，方便掌握进度
      current: parsed.raw || path.basename(file),
      currentArtist: parsed.artist,
      currentTitle: parsed.title,
      message: `${done}/${files.length}　${parsed.artist} - ${parsed.title}`,
    });
  });

  songs.sort(
    (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN') || a.artist.localeCompare(b.artist, 'zh-Hans-CN'),
  );

  const library = {
    version: 3,
    updatedAt: Date.now(),
    stats: {
      total: songs.length,
      scanMs: Date.now() - started,
      files: files.length,
      reused,
      probeFailed: failed,
      deepScan,
      concurrency,
    },
    songs,
    artists: [...artistMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN')),
  };

  onProgress({
    phase: 'done',
    done: songs.length,
    total: songs.length,
    message: `扫描完成，共 ${songs.length} 首、${artistMap.size} 位歌手${deepScan && failed ? `（${failed} 首音轨待补）` : ''}`,
  });
  log(
    `[scan] 完成：${songs.length} 首 / ${artistMap.size} 位歌手，复用元信息 ${reused}，用时 ${((Date.now() - started) / 1000).toFixed(1)}s（deepScan=${deepScan}）`,
  );
  return library;
}
