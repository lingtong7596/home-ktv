/**
 * 歌手头像自动抓取
 *
 * 思路：用公开的音乐平台搜索接口按歌手名检索，取头像图（网易云优先），
 * 下载后存到 data/avatars/<artistId>.jpg，前端直接走已有的
 * /api/artists/:id/avatar 拿图。抓不到的记进 miss 表，避免每次重扫都撞墙。
 *
 * 为什么不做"逐首音频分析"那套重活：这台 NAS 是 J1900，纯网络请求 + 存文件才跑得动。
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// 网易云支持 ?param=WxH 让服务端直接裁好图，省流量也省本地空间
const PIC_SIZE = '240y240';
const FETCH_TIMEOUT = 9000;

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s·・.,，、"'“”‘’()（）\[\]【】]/g, '')
    .trim();
}

export function createAvatarFetcher({ library, hub, cfg }) {
  const missFile = path.join(cfg.dataDir, 'avatar-misses.json');
  let misses = {};
  try {
    misses = JSON.parse(fs.readFileSync(missFile, 'utf8')) || {};
  } catch {
    misses = {};
  }

  const state = {
    running: false,
    total: 0,
    done: 0,
    ok: 0,
    fail: 0,
    skipped: 0,
    current: '',
    startedAt: 0,
    finishedAt: 0,
    lastError: '',
  };

  let saveMissTimer = null;
  function saveMisses() {
    clearTimeout(saveMissTimer);
    saveMissTimer = setTimeout(() => {
      try {
        fs.writeFileSync(missFile, JSON.stringify(misses), 'utf8');
      } catch { /* 只读目录忽略 */ }
    }, 1500);
  }

  function broadcast() {
    try {
      hub?.broadcast('avatarProgress', { ...state });
    } catch { /* 没客户端也无所谓 */ }
  }

  /** 网易云：按歌手名搜，返回尽量精确匹配的头像地址 */
  async function searchNetease(name) {
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(name)}&type=100&limit=5`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const list = (j?.result?.artists) || [];
    if (!list.length) return null;
    const target = normName(name);
    // 先找完全同名的，找不到再接受"包含"关系（避免张冠李戴）
    let hit = list.find((a) => normName(a.name) === target);
    if (!hit) {
      hit = list.find((a) => {
        const n = normName(a.name);
        return n && target && (n.includes(target) || target.includes(n));
      });
    }
    if (!hit || !hit.picUrl) return null;
    const base = String(hit.picUrl).replace(/^http:/, 'https:');
    return { url: `${base}?param=${PIC_SIZE}`, source: 'netease', matched: hit.name };
  }

  async function download(url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://music.163.com/' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error('图片过小');
    return buf;
  }

  /** 抓一位歌手，成功返回 true */
  async function fetchOne(artist, { force = false } = {}) {
    if (!artist) return false;
    if (!force && library.hasAvatar(artist.id)) return true;
    const hit = await searchNetease(artist.name);
    if (!hit) {
      misses[artist.name] = Date.now();
      saveMisses();
      return false;
    }
    const buf = await download(hit.url);
    const file = library.avatarFile(artist.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    delete misses[artist.name];
    saveMisses();
    return true;
  }

  async function loop(album, { force = false } = {}) {
    const t0 = Date.now();
    for (const artist of album) {
      state.current = artist.name;
      try {
        const ok = await fetchOne(artist, { force });
        if (ok) state.ok++;
        else state.fail++;
      } catch (e) {
        state.fail++;
        state.lastError = `${artist.name}: ${e.message}`;
      }
      state.done++;
      broadcast();
      // 别把对方接口打疼了，也给自己留点空隙
      await new Promise((r) => setTimeout(r, 180));
    }
    state.running = false;
    state.current = '';
    state.finishedAt = Date.now();
    state.costMs = Date.now() - t0;
    broadcast();
  }

  return {
    status() {
      return { ...state };
    },

    /** 批量抓取：默认只抓还没有头像的，force=true 全部重抓 */
    async fetchAll({ force = false, limit = 0 } = {}) {
      if (state.running) return { started: false, reason: 'running' };
      let album = library.artists || [];
      if (!force) album = album.filter((a) => !library.hasAvatar(a.id));
      if (limit > 0) album = album.slice(0, limit);
      Object.assign(state, {
        running: true, total: album.length, done: 0, ok: 0, fail: 0, skipped: 0,
        current: '', startedAt: Date.now(), finishedAt: 0, lastError: '', costMs: 0,
      });
      broadcast();
      loop(album, { force }).catch((e) => {
        state.running = false;
        state.lastError = e.message;
        broadcast();
      });
      return { started: true, total: album.length };
    },

    async fetchById(id, { force = true } = {}) {
      const artist = library.artistById.get(id);
      if (!artist) return { ok: false, error: '未找到歌手' };
      try {
        const ok = await fetchOne(artist, { force });
        return { ok, artist: artist.name, hasAvatar: library.hasAvatar(artist.id) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}
