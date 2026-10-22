import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, saveConfig, ROOT } from './src/config.js';
import { Library } from './src/library.js';
import { Playback } from './src/playback.js';
import { Remuxer } from './src/remux.js';
import { createHub } from './src/events.js';
import { scanLibrary } from './src/scanner.js';
import { ffmpegAvailable } from './src/probe.js';
import { qrSvg } from './src/qr.js';
import { toPinyin } from './src/pinyin.js';
import { shortHash } from './src/util.js';
import { log, humanSize } from './src/util.js';

const cfg = loadConfig();
const hub = createHub();
const library = new Library(cfg);
const remuxer = new Remuxer(cfg);
const playback = new Playback(cfg, library, remuxer, hub);

const VERSION = '1.2.0';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.ts': 'video/mp2t',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------ 工具 ------------------------------ */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** 原始二进制请求体（头像上传用） */
function readRawBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('文件过大（上限 5MB）'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function lanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    }
  }
  return candidates.find((ip) => ip.startsWith('192.168.')) || candidates[0] || '127.0.0.1';
}

/* 家庭自用：后台不设口令。以前的管理口令功能已移除，
 * 保留这个函数是为了让各路由的调用点不用改（永远放行）。 */
function requireAdmin() {
  return true;
}

function contentDisposition(name) {
  return `inline; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 支持 Range 的文件响应（拖动进度条、边下边播的关键） */
function serveFile(req, res, file, { download = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    json(res, 404, { error: '文件不存在' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  const total = stat.size;
  const range = req.headers.range;
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600',
    'Content-Disposition': contentDisposition(path.basename(file)),
  };
  if (download) headers['Content-Disposition'] = 'attachment';

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? null : Number(m[1]);
      let end = m[2] === '' ? null : Number(m[2]);
      if (start === null && end === null) {
        // 忽略非法 Range
      } else {
        if (start === null) {
          start = Math.max(0, total - end);
          end = total - 1;
        } else if (end === null || end >= total) {
          end = total - 1;
        }
        if (start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }
        headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
        headers['Content-Length'] = end - start + 1;
        res.writeHead(206, headers);
        if (req.method === 'HEAD') return res.end();
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }
    }
  }

  headers['Content-Length'] = total;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ------------------------------ 扫描控制 ------------------------------ */

const scanState = { running: false, progress: { phase: 'idle', done: 0, total: 0, message: '' }, finishedAt: 0 };

async function startScan() {
  if (scanState.running) return { started: false, reason: '正在扫描中' };
  if (!cfg.mediaDirs.length) return { started: false, reason: '尚未配置曲库目录' };
  scanState.running = true;
  scanState.progress = { phase: 'start', done: 0, total: 0, message: '开始扫描' };
  hub.broadcast('scan', scanState);
  scanLibrary(cfg, {
    onProgress: (p) => {
      scanState.progress = p;
      hub.broadcast('scan', { running: true, progress: p });
    },
    prevSongs: library.byIdMap,
    skipFiles: library.removedFiles,
  })
    .then((lib) => {
      library.replace(lib);
      scanState.finishedAt = Date.now();
      const missing = playback.queue.filter((item) => !library.get(item.songId)).length;
      hub.broadcast('library', { total: library.songs.length, facets: library.langFacets() });
      playback.broadcast();
      log(`[scan] 曲库已更新：${library.songs.length} 首${missing ? `，${missing} 首队列歌曲已失效` : ''}`);
    })
    .catch((err) => {
      log('[scan] 失败:', err.message);
      scanState.progress = { phase: 'error', message: err.message };
    })
    .finally(() => {
      scanState.running = false;
      hub.broadcast('scan', scanState);
    });
  return { started: true };
}

/* ------------------------------ 路由 ------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Pin',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  try {
    /* ---- 页面 ---- */
    if (pathname === '/' && method === 'GET') {
      const landing = path.join(cfg.publicDir, 'index.html');
      if (fs.existsSync(landing)) return serveFile(req, res, landing);
      res.writeHead(302, { Location: '/play/' });
      return res.end();
    }

    /* ---- 头像占位图（无头像歌手用名字首字生成） ---- */
    if (pathname === '/api/avatar-placeholder.svg') {
      const name = url.searchParams.get('name') || '歌';
      const ch = [...name.trim()][0] || '歌';
      const hue = [...name].reduce((h, c) => h + c.codePointAt(0), 0) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="hsl(${hue},45%,42%)"/><text x="64" y="86" font-size="56" text-anchor="middle" fill="#fff" font-family="sans-serif">${ch}</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
      return res.end(svg);
    }

    /* ---- 健康检查 / 基础信息 ---- */
    if (pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        version: VERSION,
        room: cfg.roomName,
        library: { total: library.songs.length, updatedAt: library.updatedAt },
        scan: scanState,
        remuxCache: await remuxer.stats(),
        clients: hub.count,
        originalTrack: cfg.originalTrack,
        accompanimentTrack: cfg.accompanimentTrack,
      });
    }

    if (pathname === '/api/config') {
      return json(res, 200, {
        room: cfg.roomName,
        originalTrack: cfg.originalTrack,
        accompanimentTrack: cfg.accompanimentTrack,
        mediaDirs: cfg.mediaDirs,
        cacheMaxGB: cfg.cacheMaxGB,
        filenameOrder: cfg.filenameOrder,
      });
    }

    /* ---- 实时事件 ---- */
    if (pathname === '/api/events') {
      const client = hub.add(req, res, { role: url.searchParams.get('role') || 'unknown' });
      hub.send(client, 'state', playback.snapshot());
      hub.send(client, 'scan', { running: scanState.running, progress: scanState.progress });
      return;
    }

    /* ---- 二维码（供投影仪屏幕显示） ---- */
    if (pathname === '/api/qr.svg') {
      const text = url.searchParams.get('text') || `http://${lanIp()}:${cfg.port}/m/`;
      const scale = Number(url.searchParams.get('scale') || 6);
      const dark = url.searchParams.get('dark') || '#ffffff';
      const light = url.searchParams.get('light') || 'transparent';
      const svg = qrSvg(text, { scale, dark, light });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(svg);
    }

    /* ---- 手机扫码后拿到的地址信息 ---- */
    if (pathname === '/api/remote-info') {
      const host = req.headers.host || `${lanIp()}:${cfg.port}`;
      const base = `http://${host}`;
      return json(res, 200, {
        base,
        mobileUrl: `${base}/m/`,
        playerUrl: `${base}/play/`,
        adminUrl: `${base}/admin/`,
        qr: `${base}/api/qr.svg?text=${encodeURIComponent(`${base}/m/`)}&scale=8`,
      });
    }

    /* ---- 曲库 ---- */
    if (pathname === '/api/songs' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const limit = Math.min(500, Number(url.searchParams.get('limit') || 40));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));
      const sort = url.searchParams.get('sort') || 'default';
      const lang = url.searchParams.get('lang') || '';
      const type = url.searchParams.get('type') || '';
      const letter = url.searchParams.get('letter') || '';
      const artist = url.searchParams.get('artist') || '';
      const includeDisabled = url.searchParams.get('includeDisabled') === '1';
      const status = url.searchParams.get('status') || '';
      const favOnly = url.searchParams.get('fav') === '1';
      const qscope = url.searchParams.get('qscope') || '';
      const result = library.search(q, { limit, offset, sort, lang, type, letter, artist, includeDisabled, status, favOnly, qscope });
      return json(res, 200, {
        total: result.total,
        offset,
        limit,
        items: result.items.map((s) => library.brief(s)),
      });
    }

    const songMatch = pathname.match(/^\/api\/songs\/([a-f0-9]+)$/);
    if (songMatch) {
      const song = library.get(songMatch[1]);
      if (!song) return json(res, 404, { error: '未找到歌曲' });
      // 懒探测：快速扫描模式下首次访问时补读音轨信息（可带 ?probe=1 强制）
      if (url.searchParams.get('probe') === '1') await library.ensureProbed(song.id);
      return json(res, 200, {
        ...library.brief(song),
        audios: song.audios,
        origTrack: song.origTrack,
        accTrack: song.accTrack,
        probeOk: song.probeOk,
        trackGuess: song.trackGuess,
      });
    }

    /* ---- 歌曲编辑 / 停用（后台手工纠正） ---- */
    const songActionMatch = pathname.match(/^\/api\/songs\/([a-f0-9]+)\/(disable|edit)$/);
    if (songActionMatch && method === 'POST') {
      if (!requireAdmin(req, res, url)) return;
      const body = await readBody(req);
      const [, id, action] = songActionMatch;
      if (action === 'disable') {
        const ok = library.setDisabled(id, !!body.disabled);
        return json(res, 200, { ok });
      }
      const ok = library.updateSong(id, body);
      return json(res, 200, { ok, song: library.brief(library.get(id)) });
    }

    /* ---- 收藏（爱心） ---- */
    if (pathname === '/api/favs' && method === 'GET') {
      return json(res, 200, { items: library.favSongs().map((s) => library.brief(s)) });
    }
    if (pathname === '/api/favs/toggle' && method === 'POST') {
      const body = await readBody(req);
      const result = library.toggleFav(String(body.songId || ''));
      if (!result) return json(res, 404, { error: '未找到歌曲' });
      playback.broadcast();
      return json(res, 200, { ok: true, ...result });
    }
    if (pathname === '/api/favs/clear' && method === 'POST') {
      library.store.favClear();
      library.favIds = [];
      playback.broadcast();
      return json(res, 200, { ok: true });
    }

    /* ---- 随机推荐 ---- */
    if (pathname === '/api/random' && method === 'GET') {
      const n = Math.min(50, Number(url.searchParams.get('n') || 20));
      const fromFavs = url.searchParams.get('from') === 'favs';
      const items = library.randomSongs(n, { fromFavs });
      return json(res, 200, { items: items.map((s) => library.brief(s)) });
    }

    /* ---- 歌星 ---- */
    if (pathname === '/api/artists' && method === 'GET') {
      const result = library.listArtists({
        q: url.searchParams.get('q') || '',
        letter: url.searchParams.get('letter') || '',
        region: url.searchParams.get('region') || '',
        gender: url.searchParams.get('gender') || '',
        limit: Math.min(500, Number(url.searchParams.get('limit') || 200)),
        offset: Math.max(0, Number(url.searchParams.get('offset') || 0)),
      });
      return json(res, 200, result);
    }
    if (pathname === '/api/artists/rebuild' && method === 'POST') {
      if (!requireAdmin(req, res, url)) return;
      // 从歌曲全量重建歌手表（保留已有地区/性别设置）
      const map = new Map();
      for (const s of library.songs) {
        const names = s.artists && s.artists.length ? s.artists : [s.artist];
        for (const name of names) {
          const key = name;
          if (!map.has(key)) {
            const py = toPinyin(name);
            map.set(key, { id: shortHash(`artist:${name}`, 12), name, py: py.py, init: py.init, count: 0 });
          }
          map.get(key).count++;
        }
      }
      library.rebuildArtists([...map.values()]);
      return json(res, 200, { ok: true, total: library.artists.length });
    }

    const artistMatch = pathname.match(/^\/api\/artists\/([a-f0-9]+)$/);
    if (artistMatch) {
      const artist = library.artistById.get(artistMatch[1]);
      if (!artist) return json(res, 404, { error: '未找到歌手' });
      if (method === 'GET') {
        const songs = library.artistSongs(artist.name);
        return json(res, 200, {
          ...artist,
          hasAvatar: library.hasAvatar(artist.id),
          songs: songs.map((s) => library.brief(s)),
        });
      }
      if (method === 'POST') {
        if (!requireAdmin(req, res, url)) return;
        const body = await readBody(req);
        const ok = library.store.artistUpdate(artist.id, {
          name: body.name != null ? String(body.name).slice(0, 60) : undefined,
          region: body.region != null ? String(body.region).slice(0, 20) : undefined,
          gender: body.gender != null ? String(body.gender).slice(0, 20) : undefined,
        });
        library.reloadArtists();
        return json(res, 200, { ok, artist: library.artistById.get(artist.id) || null });
      }
    }

    const avatarMatch = pathname.match(/^\/api\/artists\/([a-f0-9]+)\/avatar$/);
    if (avatarMatch) {
      const artist = library.artistById.get(avatarMatch[1]);
      if (!artist) return json(res, 404, { error: '未找到歌手' });
      const file = library.avatarFile(artist.id);
      if (method === 'GET') {
        if (!library.hasAvatar(artist.id)) {
          // 没有头像时返回一个内置占位图（SVG 数据由前端兜底也可以）
          res.writeHead(302, { Location: '/api/avatar-placeholder.svg?name=' + encodeURIComponent(artist.name) });
          return res.end();
        }
        return serveFile(req, res, file);
      }
      if (method === 'POST') {
        if (!requireAdmin(req, res, url)) return;
        const buf = await readRawBody(req, 5 * 1024 * 1024);
        if (!buf.length) {
          // 空请求 = 删除头像
          try { fs.unlinkSync(file); } catch {}
          library.reloadArtists();
          return json(res, 200, { ok: true, deleted: true });
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        library.reloadArtists();
        return json(res, 200, { ok: true, size: buf.length });
      }
    }

    /* ---- 设置（含自动播放模式） ---- */
    if (pathname === '/api/settings' && method === 'GET') {
      return json(res, 200, {
        roomName: cfg.roomName,
        mediaDirs: cfg.mediaDirs,
        autoplayMode: cfg.autoplayMode,
        noRepeat: cfg.noRepeat,
        prewarm: cfg.prewarm,
        allowRemux: cfg.allowRemux,
        deepScan: cfg.deepScan,
        filenameOrder: cfg.filenameOrder,
        originalTrack: cfg.originalTrack,
        accompanimentTrack: cfg.accompanimentTrack,
        probeConcurrency: cfg.probeConcurrency,
        cacheMaxGB: cfg.cacheMaxGB,
        removedCount: library.removedFiles.size,
      });
    }
    if (pathname === '/api/settings' && method === 'POST') {
      const body = await readBody(req);
      if (body.roomName != null) cfg.roomName = String(body.roomName).slice(0, 20);
      if (Array.isArray(body.mediaDirs)) cfg.mediaDirs = body.mediaDirs.filter(Boolean).map((d) => path.resolve(d));
      if (['off', 'random', 'favs'].includes(body.autoplayMode)) cfg.autoplayMode = body.autoplayMode;
      if (typeof body.noRepeat === 'boolean') cfg.noRepeat = body.noRepeat;
      if (typeof body.prewarm === 'boolean') cfg.prewarm = body.prewarm;
      if (typeof body.allowRemux === 'boolean') cfg.allowRemux = body.allowRemux;
      if (typeof body.deepScan === 'boolean') cfg.deepScan = body.deepScan;
      if (['artist-title', 'title-artist'].includes(body.filenameOrder)) cfg.filenameOrder = body.filenameOrder;
      if (Number.isInteger(body.originalTrack)) cfg.originalTrack = body.originalTrack;
      if (Number.isInteger(body.accompanimentTrack)) cfg.accompanimentTrack = body.accompanimentTrack;
      if (Number.isFinite(body.probeConcurrency)) cfg.probeConcurrency = body.probeConcurrency;
      if (Number.isFinite(body.cacheMaxGB)) cfg.cacheMaxGB = body.cacheMaxGB;
      saveConfig(cfg);
      playback.broadcast();
      return json(res, 200, { ok: true });
    }

    /* ---- 单曲音轨覆盖：后台纠正原唱/伴唱顺序 ---- */
    const trackMatch = pathname.match(/^\/api\/songs\/([a-f0-9]+)\/tracks$/);
    if (trackMatch && method === 'POST') {
      const body = await readBody(req);
      const orig = body.origTrack === null ? null : Number(body.origTrack);
      const acc = body.accTrack === null ? null : Number(body.accTrack);
      const ok = library.setTrackOverride(trackMatch[1], Number.isFinite(orig) ? orig : null, Number.isFinite(acc) ? acc : null);
      if (!ok) return json(res, 404, { error: '未找到歌曲' });
      playback.broadcast();
      return json(res, 200, { ok: true, song: library.brief(library.get(trackMatch[1])) });
    }

    if (pathname === '/api/facets') {
      return json(res, 200, {
        total: library.songs.length,
        langs: library.langFacets(),
        types: library.typeFacets(),
      });
    }

    /* ---- 房间状态 / 点歌 ---- */
    if (pathname === '/api/state') return json(res, 200, playback.snapshot());

    if (pathname === '/api/queue' && method === 'POST') {
      const body = await readBody(req);
      const by = String(body.by || '').slice(0, 24);
      if (Array.isArray(body.songIds)) {
        const results = playback.addMany(body.songIds, by);
        return json(res, 200, { ok: true, results, state: playback.snapshot() });
      }
      if (!body.songId) return json(res, 400, { error: '缺少 songId' });
      let result;
      try {
        result = playback.add(String(body.songId), by);
      } catch (err) {
        return json(res, 409, { error: err.message });
      }
      const song = library.get(String(body.songId));
      hub.broadcast('toast', { text: `已点：${song.artist} - ${song.title}`, by });
      return json(res, 200, { ok: true, ...result, song: library.brief(song), state: playback.snapshot() });
    }

    const qidMatch = pathname.match(/^\/api\/queue\/([a-zA-Z0-9]+)\/(remove|top|play)$/);
    if (qidMatch && method === 'POST') {
      const [, qid, action] = qidMatch;
      let result;
      if (action === 'remove') result = playback.remove(qid);
      else if (action === 'top') result = { ok: playback.top(qid) };
      else result = { ok: playback.jumpTo(qid) };
      return json(res, 200, { ok: true, result, state: playback.snapshot() });
    }

    if (pathname === '/api/queue/clear' && method === 'POST') {
      playback.clearQueue();
      return json(res, 200, { ok: true, state: playback.snapshot() });
    }

    if (pathname === '/api/queue/shuffle' && method === 'POST') {      const ok = playback.shuffle();
      return json(res, 200, { ok, state: playback.snapshot() });
    }

    /* ---- 撤销"从曲库移除"（下次扫描会重新收录） ---- */
    if (pathname === '/api/songs/restore-removed' && method === 'POST') {
      const n = library.removedFiles.size;
      library.restoreRemoved();
      return json(res, 200, { ok: true, restored: n });
    }

    /* ---- 批量操作（后台勾选后一次性处理） ---- */
    if (pathname === '/api/songs/batch' && method === 'POST') {
      const body = await readBody(req);
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter(Boolean);
      const action = String(body.action || '');
      if (!ids.length) return json(res, 400, { error: '没有勾选歌曲' });
      let n = 0;
      if (action === 'fav') n = library.batchFav(ids, true);
      else if (action === 'unfav') n = library.batchFav(ids, false);
      else if (action === 'disable') n = library.setDisabledMany(ids, true);
      else if (action === 'enable') n = library.setDisabledMany(ids, false);
      else if (action === 'remove') n = library.removeSongs(ids);
      else if (action === 'queue') n = playback.addMany(ids, String(body.by || '后台')).filter((r) => r.ok).length;
      else if (action === 'enqueueRandom') {
        // 勾选的这批先打乱再入队
        const shuffled = [...ids].sort(() => Math.random() - 0.5);
        n = playback.addMany(shuffled, String(body.by || '后台')).filter((r) => r.ok).length;
      } else return json(res, 400, { error: '未知操作' });
      playback.broadcast();
      return json(res, 200, { ok: true, affected: n, total: ids.length, state: playback.snapshot() });
    }

    /* ---- 播放控制 ---- */
    if (pathname.startsWith('/api/player/') && method === 'POST') {
      const action = pathname.slice('/api/player/'.length);
      const body = await readBody(req);
      let ok = true;
      switch (action) {
        case 'next': playback.next(); break;
        case 'prev': playback.prev(); break;
        case 'pause': playback.setPaused(true); break;
        case 'resume': playback.setPaused(false); break;
        case 'toggle': playback.setPaused(!(playback.current && playback.current.paused)); break;
        case 'track': ok = playback.setTrack(Number(body.track)); break;
        case 'toggle-track': ok = playback.toggleTrack(); break;
        case 'seek': ok = playback.seek(Number(body.position)); break;
        case 'replay': ok = playback.replay(); break;
        case 'report':
          playback.report({
            position: typeof body.position === 'number' ? body.position : undefined,
            paused: typeof body.paused === 'boolean' ? body.paused : undefined,
            ended: !!body.ended,
          });
          return json(res, 200, { ok: true }); // 高频率上报，不回状态
        default:
          return json(res, 404, { error: '未知操作' });
      }
      return json(res, 200, { ok, state: playback.snapshot() });
    }

    /* ---- 播放准备状态（客户端播放前先问一次） ---- */
    const prepMatch = pathname.match(/^\/api\/prepare\/([a-f0-9]+)$/);
    if (prepMatch) {
      const song = library.get(prepMatch[1]);
      if (!song) return json(res, 404, { error: '未找到歌曲' });
      const trackParam = url.searchParams.get('track');
      let track = Number(trackParam || playback.current?.track || 0);
      const client = url.searchParams.get('client') === 'apk' ? 'apk' : 'web';
      const opts = { forceCompat: url.searchParams.get('compat') === '1' };

      // 快速扫描入库的歌没有音轨/编码信息，先补读这一个文件头（0.1~0.3s）
      if (!song.trackCount) {
        await library.ensureProbed(song.id);
        playback.syncTrackOf(song);
        // 客户端没指定音轨时，探测完按当前「原唱/伴唱」角色给正确的轨号
        if (!trackParam) track = playback.roleTrack(song);
      }

      const plan = remuxer.decide(song, track, client, opts);
      if (plan.kind === 'direct') {
        return json(res, 200, {
          state: 'ready', direct: true, progress: 100,
          url: `/stream/${song.id}?track=${track}&client=${client}`,
        });
      }
      if (plan.kind === 'unsupported') {
        return json(res, 200, { state: 'unsupported', progress: 0, error: plan.reason });
      }
      // 兼容处理被关掉：告诉前端"别再等了，直接拿原文件播"
      if (!cfg.allowRemux) {
        return json(res, 200, { state: 'off', progress: 0, error: '播放兼容处理未开启' });
      }
      if (url.searchParams.get('start') === '1') {
        remuxer.ensure(song, track, client, opts).catch(() => {});
      }
      return json(res, 200, remuxer.status(song, track, client, opts));
    }

    /* ---- 视频流 ---- */
    const streamMatch = pathname.match(/^\/stream\/([a-f0-9]+)$/);
    if (streamMatch) {
      const song = library.get(streamMatch[1]);
      if (!song) return json(res, 404, { error: '未找到歌曲' });
      if (!fs.existsSync(song.file)) return json(res, 410, { error: '源文件已不存在，请重新扫描曲库' });

      const raw = url.searchParams.get('raw') === '1';
      let track = Number(url.searchParams.get('track') || 0);
      const client = url.searchParams.get('client') === 'apk' ? 'apk' : 'web';
      const opts = { forceCompat: url.searchParams.get('compat') === '1' };

      if (raw) return serveFile(req, res, song.file);

      // 需要按编码判定（浏览器/投影仪能力不同），没探测过就先补一次文件头
      if (!song.trackCount) {
        await library.ensureProbed(song.id);
        playback.syncTrackOf(song);
        if (!url.searchParams.get('track')) track = playback.roleTrack(song);
      }
      const plan = cfg.allowRemux ? remuxer.decide(song, track, client, opts) : { kind: 'direct' };

      if (plan.kind === 'direct') return serveFile(req, res, song.file);
      if (plan.kind === 'unsupported' || !cfg.allowRemux) {
        return json(res, 415, {
          error: plan.reason || '该片源需要播放兼容处理，请在后台「系统设置」里打开',
        });
      }

      const status = remuxer.status(song, track, client, opts);
      if (status.state === 'ready') return serveFile(req, res, remuxer.cacheFile(song.id, track, plan.container));
      if (status.state === 'none') {
        remuxer.ensure(song, track, client, opts).catch(() => {});
      }
      if (status.state === 'error') return json(res, 500, { error: status.error || '音轨处理失败' });
      // 正在处理：让客户端等一会儿再来（425 Too Early）
      res.writeHead(425, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
      return res.end(JSON.stringify({ state: status.state, progress: status.progress, retryAfter: 1.5 }));
    }

    /* ---- 后台 ---- */
    if (pathname === '/api/admin/stats') {
      if (!requireAdmin(req, res, url)) return;
      return json(res, 200, {
        library: { total: library.songs.length, updatedAt: library.updatedAt, stats: library.stats },
        cache: await remuxer.stats(),
        scan: scanState,
        mediaDirs: cfg.mediaDirs,
        clients: hub.count,
        ffmpeg: await ffmpegAvailable(cfg.ffmpeg),
        state: {
          hasCurrent: !!playback.current,
          queueLength: playback.queue.length,
        },
      });
    }

    if (pathname === '/api/scan' && method === 'POST') {
      if (!requireAdmin(req, res, url)) return;
      const body = await readBody(req);
      // 批量导入的命名方式与扫描深度可以随扫随改
      if (['artist-title', 'title-artist'].includes(body.filenameOrder)) cfg.filenameOrder = body.filenameOrder;
      if (typeof body.deepScan === 'boolean') cfg.deepScan = body.deepScan;
      saveConfig(cfg);
      const result = await startScan();
      return json(res, 200, { ...result, filenameOrder: cfg.filenameOrder, deepScan: cfg.deepScan });
    }

    if (pathname === '/api/scan/status') {
      return json(res, 200, { running: scanState.running, progress: scanState.progress, finishedAt: scanState.finishedAt });
    }

    if (pathname === '/api/admin/cache/clear' && method === 'POST') {
      if (!requireAdmin(req, res, url)) return;
      await remuxer.clear();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/config' && method === 'POST') {
      if (!requireAdmin(req, res, url)) return;
      const body = await readBody(req);
      if (body.roomName) cfg.roomName = String(body.roomName).slice(0, 20);
      if (Array.isArray(body.mediaDirs)) cfg.mediaDirs = body.mediaDirs.filter(Boolean).map((d) => path.resolve(d));
      if (Number.isInteger(body.originalTrack)) cfg.originalTrack = body.originalTrack;
      if (Number.isInteger(body.accompanimentTrack)) cfg.accompanimentTrack = body.accompanimentTrack;
      if (Number.isFinite(body.cacheMaxGB)) cfg.cacheMaxGB = body.cacheMaxGB;
      if (typeof body.filenameOrder === 'string') cfg.filenameOrder = body.filenameOrder;
      saveConfig(cfg);
      return json(res, 200, { ok: true, config: { room: cfg.roomName, mediaDirs: cfg.mediaDirs } });
    }

    /* ---- 静态文件 ---- */
    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/stream/')) {
      let rel = decodeURIComponent(pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const full = path.join(cfg.publicDir, rel);
      if (full.startsWith(cfg.publicDir) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        return serveFile(req, res, full);
      }
      // 单页应用回退
      const fallbackDir = path.join(cfg.publicDir, rel.split('/').slice(0, 2).join('/'), 'index.html');
      if (fs.existsSync(fallbackDir)) return serveFile(req, res, fallbackDir);
    }

    json(res, 404, { error: 'Not Found' });
  } catch (err) {
    log('请求异常:', req.method, pathname, err.message);
    if (!res.headersSent) json(res, 500, { error: err.message });
    else res.end();
  }
});

/* ------------------------------ 启动 ------------------------------ */

async function main() {
  const hasFfmpeg = await ffmpegAvailable(cfg.ffmpeg);
  if (!hasFfmpeg) log(`⚠️  未找到 ffmpeg（配置项 ffmpeg=${cfg.ffmpeg}），原唱/伴唱切换将不可用`);

  server.listen(cfg.port, cfg.host, () => {
    const ip = lanIp();
    log(`家庭 KTV 服务已启动  房间：${cfg.roomName}`);
    log(`  投影仪播放页 : http://${ip}:${cfg.port}/play/`);
    log(`  手机点歌台   : http://${ip}:${cfg.port}/m/`);
    log(`  后台管理     : http://${ip}:${cfg.port}/admin/`);
    log(`  曲库         : ${library.songs.length} 首   目录：${cfg.mediaDirs.join(', ') || '（未配置）'}`);
  });

  if (cfg.autoScanOnStart && cfg.mediaDirs.length) {
    const stale = !library.songs.length || Date.now() - library.updatedAt > 12 * 3600 * 1000;
    if (stale) {
      log('[scan] 启动自动扫描曲库…');
      startScan();
    }
  }
}

process.on('SIGINT', async () => {
  log('正在退出，保存播放次数…');
  try { library.persist(); } catch {}
  process.exit(0);
});

main();
