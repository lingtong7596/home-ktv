import fs from 'node:fs';
import path from 'node:path';
import { readJson, shortHash } from './util.js';
import { openSongStore } from './db.js';
import { ffprobe } from './probe.js';
import { detectTracks } from './detectTracks.js';
import { toPinyin } from './pinyin.js';

/**
 * 曲库：SQLite 持久化 + 常驻内存索引
 *
 * 检索在内存里做（中文/拼音模糊打分用 SQL 表达既慢又啰嗦），
 * SQLite 只负责持久化与用户数据（点唱次数、单曲音轨覆盖）的可靠落盘。
 */
export class Library {
  constructor(cfg) {
    this.cfg = cfg;
    this.songs = [];
    this.byIdMap = new Map();
    this.artists = [];
    this.artistById = new Map();
    this.favIds = [];
    this.updatedAt = 0;
    this.stats = { total: 0 };
    this.store = openSongStore(cfg.dataDir);
    this.probing = new Set(); // 正在懒探测的歌曲，避免并发重复读
    this.load();
  }

  load() {
    let songs = this.store.all();

    // 从旧版 library.json 平滑迁移（只迁一次）
    if (!songs.length) {
      const legacy = readJson(path.join(this.cfg.dataDir, 'library.json'), null);
      if (legacy && Array.isArray(legacy.songs) && legacy.songs.length) {
        this.store.upsertScan(legacy.songs);
        songs = this.store.all();
      }
    }

    this.songs = songs;
    const meta = Number(this.store.getMeta('last_scan') || 0);
    this.updatedAt = meta || Date.now();
    this.stats = { total: songs.length };
    this.byIdMap = new Map(songs.map((s) => [s.id, s]));

    // 老版本升级上来的库：songs 有数据但 artists 表还是空的 → 就地补建，
    // 不必等用户重新扫一遍曲库才能用「歌星」页
    if (songs.length && !this.store.artistsAll().length) {
      const agg = new Map();
      for (const s of songs) {
        const names = s.artists && s.artists.length ? s.artists : [s.artist];
        for (const n of names) {
          if (!n) continue;
          if (!agg.has(n)) {
            const py = toPinyin(n);
            agg.set(n, { id: shortHash(`artist:${n}`, 12), name: n, py: py.py, init: py.init });
          }
        }
      }
      if (agg.size) this.store.upsertArtists([...agg.values()]);
    }
    this.reloadArtists();
    this.favIds = this.store.favAll().map((r) => r.song_id);
    // 后台"批量删除"过的文件，重扫时不再收回来
    this.removedFiles = new Set(this.store.removedFiles());
  }

  /** 从 songs 重建歌手内存索引（保留库里已有的地区/性别设置） */
  rebuildArtists(scanArtists) {
    if (Array.isArray(scanArtists) && scanArtists.length) {
      this.store.upsertArtists(scanArtists);
    }
    this.reloadArtists();
  }

  reloadArtists() {
    const rows = this.store.artistsAll();
    const counts = new Map();
    const plays = new Map();
    for (const s of this.songs) {
      const names = s.artists && s.artists.length ? s.artists : [s.artist];
      for (const n of names) {
        counts.set(n, (counts.get(n) || 0) + 1);
        plays.set(n, (plays.get(n) || 0) + (s.plays || 0));
      }
    }
    this.artists = rows
      .filter((a) => counts.has(a.name))
      .map((a) => ({ ...a, count: counts.get(a.name) || 0, plays: plays.get(a.name) || 0 }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    this.artistById = new Map(this.artists.map((a) => [a.id, a]));
  }

  avatarFile(id) {
    return path.join(this.cfg.dataDir, 'avatars', `${id}.jpg`);
  }

  hasAvatar(id) {
    try {
      return fs.statSync(this.avatarFile(id)).isFile();
    } catch {
      return false;
    }
  }

  listArtists({ q = '', letter = '', region = '', gender = '', limit = 200, offset = 0 } = {}) {
    let list = this.artists;
    if (letter) list = list.filter((a) => (a.init || '?')[0].toUpperCase() === letter.toUpperCase());
    if (region) list = list.filter((a) => a.region === region);
    if (gender) list = list.filter((a) => a.gender === gender);
    if (q) {
      const t = q.toLowerCase();
      list = list.filter(
        (a) => a.name.toLowerCase().includes(t) || (a.py || '').includes(t) || (a.init || '').startsWith(t),
      );
    }
    return {
      total: list.length,
      items: list.slice(offset, offset + limit).map((a) => ({
        ...a,
        hasAvatar: this.hasAvatar(a.id),
      })),
    };
  }

  artistSongs(name) {
    const list = this.songs.filter(
      (s) => !s.disabled && ((s.artist === name) || (s.artists && s.artists.includes(name))),
    );
    list.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
    return list;
  }

  /* ---------- 收藏 ---------- */
  isFav(songId) {
    return this.favIds.includes(songId);
  }

  toggleFav(songId) {
    const song = this.byIdMap.get(songId);
    if (!song) return null;
    if (this.isFav(songId)) {
      this.store.favRemove(songId);
      this.favIds = this.favIds.filter((id) => id !== songId);
      return { fav: false };
    }
    this.store.favAdd(songId);
    this.favIds = [songId, ...this.favIds];
    return { fav: true };
  }

  favSongs() {
    return this.favIds.map((id) => this.byIdMap.get(id)).filter(Boolean);
  }

  /* ---------- 随机选歌（自动播放用） ---------- */
  randomSongs(n = 1, { fromFavs = false, exclude = [] } = {}) {
    const skip = new Set(exclude);
    let pool = fromFavs ? this.favSongs() : this.songs.filter((s) => !s.disabled);
    pool = pool.filter((s) => !skip.has(s.id));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.slice(0, n);
  }

  /** 停用/启用（停用后各端搜不到、不可点） */
  setDisabled(id, disabled) {
    const song = this.byIdMap.get(id);
    if (!song) return false;
    song.disabled = !!disabled;
    this.store.setDisabled(id, disabled);
    return true;
  }

  /** 批量停用/启用 */
  setDisabledMany(ids = [], disabled) {
    let n = 0;
    for (const id of ids) if (this.setDisabled(id, disabled)) n++;
    return n;
  }

  /** 批量收藏 / 取消收藏 */
  batchFav(ids = [], fav = true) {
    let n = 0;
    for (const id of ids) {
      if (!this.byIdMap.has(id)) continue;
      const isFav = this.isFav(id);
      if (fav && !isFav) {
        this.store.favAdd(id);
        this.favIds = [id, ...this.favIds];
        n++;
      } else if (!fav && isFav) {
        this.store.favRemove(id);
        this.favIds = this.favIds.filter((x) => x !== id);
        n++;
      }
    }
    return n;
  }

  /**
   * 从曲库移除（后台批量删除）。
   * 只删索引 + 记黑名单，**不动 NAS 上的原视频文件**。
   */
  removeSongs(ids = []) {
    const files = this.store.removeSongs(ids.filter((id) => this.byIdMap.has(id)));
    const drop = new Set(ids);
    this.songs = this.songs.filter((s) => !drop.has(s.id));
    this.byIdMap = new Map(this.songs.map((s) => [s.id, s]));
    this.favIds = this.store.favAll().map((r) => r.song_id);
    this.removedFiles = new Set(this.store.removedFiles());
    this.reloadArtists();
    return files.length;
  }

  /** 把"已移除"黑名单清空，下次扫描会重新收录 */
  restoreRemoved() {
    this.store.restoreFiles([...this.removedFiles]);
    this.removedFiles = new Set();
  }

  /** 后台手工纠正解析结果（歌名/歌手/语种/类型），并重算拼音索引 */
  updateSong(id, patch) {
    const song = this.byIdMap.get(id);
    if (!song) return false;
    const title = patch.title != null ? String(patch.title).trim() : song.title;
    const artist = patch.artist != null ? String(patch.artist).trim() : song.artist;
    const tPy = toPinyin(title);
    const aPy = toPinyin(artist);
    const next = {
      title,
      artist,
      artists: artist.includes('&') ? artist.split('&').map((x) => x.trim()).filter(Boolean) : song.artists,
      lang: patch.lang != null ? patch.lang : song.lang,
      type: patch.type != null ? patch.type : song.type,
      py: tPy.py,
      init: tPy.init,
      apy: aPy.py,
      ainit: aPy.init,
      pinit: aPy.init + tPy.init,
    };
    Object.assign(song, next);
    this.store.updateSongMeta(id, next);
    return true;
  }

  /**
   * 懒探测：快速扫描模式下歌曲没有音轨/时长信息，
   * 首次点唱时补读这一个文件的文件头（约 2-3 秒），结果落库，之后不再读。
   */
  async ensureProbed(id) {
    const song = this.byIdMap.get(id);
    if (!song || song.probeOk || this.probing.has(id)) return song;
    if (!fs.existsSync(song.file)) return song;
    this.probing.add(id);
    try {
      const info = await ffprobe(song.file, this.cfg.ffprobe, this.cfg.probeTimeout || 45000);
      if (info) {
        song.duration = Math.round(info.duration || 0);
        song.width = info.width || 0;
        song.height = info.height || 0;
        song.vcodec = info.vcodec || '';
        song.audios = info.audios || [];
        song.trackCount = (info.audios || []).length;
        song.probeOk = true;
        if (song.trackCount > 0 && song.origTrack == null && song.accTrack == null) {
          const guess = detectTracks(info.audios);
          song.trackGuess = guess.reason;
          if (guess.orig != null && guess.acc != null) {
            song.origTrack = guess.orig;
            song.accTrack = guess.acc;
          }
        }
        // 持久化（保留用户数据）
        this.store.upsertScan([{ ...song, plays: song.plays || 0 }]);
      }
    } catch {
      /* 网盘超时等：下首再试 */
    } finally {
      this.probing.delete(id);
    }
    return song;
  }

  replace(library) {
    const songs = library.songs || [];
    const result = this.store.upsertScan(songs);
    this.songs = this.store.all();
    this.byIdMap = new Map(this.songs.map((s) => [s.id, s]));
    this.updatedAt = library.updatedAt || Date.now();
    this.stats = { ...(library.stats || {}), total: this.songs.length, db: result };
    if (library.artists) this.rebuildArtists(library.artists);
    else this.reloadArtists();
    this.favIds = this.store.favAll().map((r) => r.song_id);
  }

  get(id) {
    return this.byIdMap.get(id) || null;
  }

  recordPlay(id) {
    const song = this.byIdMap.get(id);
    if (!song) return;
    song.plays = (song.plays || 0) + 1;
    song.lastPlayed = Date.now();
    this.store.incPlay(id);
  }

  /** 单曲音轨覆盖（原唱/伴唱对调，或该曲只有伴奏） */
  setTrackOverride(id, origTrack, accTrack) {
    const song = this.byIdMap.get(id);
    if (!song) return false;
    song.origTrack = origTrack ?? null;
    song.accTrack = accTrack ?? null;
    this.store.setTrackOverride(id, origTrack, accTrack);
    return true;
  }

  /** 兼容旧调用：写库已在 replace / recordPlay 内完成 */
  persist() {
    /* no-op */
  }

  /** 歌曲对外精简结构（列表、队列都用它，减少流量） */
  brief(song) {
    if (!song) return null;
    return {
      id: song.id,
      title: song.title,
      artist: song.artist,
      artists: song.artists && song.artists.length > 1 ? song.artists : undefined,
      lang: song.lang,
      type: song.type,
      duration: song.duration,
      trackCount: song.trackCount,
      width: song.width,
      height: song.height,
      vcodec: song.vcodec,
      plays: song.plays || 0,
      rel: song.rel,
      disabled: !!song.disabled,
      fav: this.isFav(song.id),
    };
  }

  search(rawQuery, { limit = 40, offset = 0, sort = 'default', lang = '', type = '', letter = '', artist = '', includeDisabled = false, status = '', favOnly = false, qscope = '' } = {}) {
    const q = String(rawQuery || '').trim().toLowerCase();
    let list = this.songs;

    if (favOnly) {
      const set = new Set(this.favIds);
      list = list.filter((s) => set.has(s.id));
    }

    if (status === 'disabled') list = list.filter((s) => s.disabled);
    else if (status === 'enabled' || !includeDisabled) list = list.filter((s) => !s.disabled);
    if (lang || type) {
      list = list.filter((s) => (!lang || s.lang === lang) && (!type || s.type === type));
    }
    if (artist) {
      list = list.filter((s) => s.artist === artist || (s.artists && s.artists.includes(artist)));
    }
    if (letter) {
      const L = letter.toUpperCase();
      list = list.filter((s) => (s.init || '?')[0].toUpperCase() === L);
    }

    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      // qscope=title：手机「歌名」大类——歌手的拼音首字母（ainit/apy/pinit）不参与筛选，
      // 避免"歌手首字母+歌名首字母"的组合把整位歌手的歌都带出来
      const noArtistInit = qscope === 'title';
      const scored = [];
      for (const song of list) {
        const score = this.score(song, terms, { noArtistInit });
        if (score > 0) scored.push({ song, score });
      }
      scored.sort((a, b) => b.score - a.score || a.song.title.localeCompare(b.song.title, 'zh-Hans-CN'));
      list = scored.map((x) => x.song);
    } else if (sort === 'hot') {
      list = [...list].sort((a, b) => (b.plays || 0) - (a.plays || 0) || (b.lastPlayed || 0) - (a.lastPlayed || 0));
    } else if (sort === 'new') {
      list = [...list].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    } else if (sort === 'artist') {
      list = [...list].sort(
        (a, b) => a.artist.localeCompare(b.artist, 'zh-Hans-CN') || a.title.localeCompare(b.title, 'zh-Hans-CN'),
      );
    }

    return {
      total: list.length,
      offset,
      limit,
      items: list.slice(offset, offset + limit),
    };
  }

  /** 每个搜索词都必须命中；命中位置越靠前、字段越重要，分数越高 */
  score(song, terms, { noArtistInit = false } = {}) {
    let total = 0;
    for (const term of terms) {
      let best = 0;
      const isLatin = /^[a-z0-9]+$/.test(term);
      const title = song.title.toLowerCase();
      const artist = song.artist.toLowerCase();

      if (title === term) best = Math.max(best, 1000);
      else if (title.startsWith(term)) best = Math.max(best, 820);
      else if (title.includes(term)) best = Math.max(best, 520);

      if (artist === term) best = Math.max(best, 700);
      else if (artist.includes(term)) best = Math.max(best, 460);
      // 多歌手别名（老狼&痛仰乐队 → 搜"痛仰"也能出）
      else if (song.artists && song.artists.some((a) => a.toLowerCase().includes(term))) best = Math.max(best, 440);

      if (isLatin) {
        if (song.init === term) best = Math.max(best, 900);
        // "歌手首字母+歌名首字母" 是 KTV 最常用的点歌方式（zjl + aqxy = zjlaqxy），
        // 必须支持前缀匹配，否则组合查询完全搜不到。
        // 手机「歌名」大类（noArtistInit）不带歌手首字母，只按歌名本身匹配
        else if (!noArtistInit && song.pinit && song.pinit === term) best = Math.max(best, 880);
        else if (!noArtistInit && song.pinit && song.pinit.startsWith(term)) best = Math.max(best, 840);
        else if (song.init && song.init.startsWith(term)) best = Math.max(best, 760);
        else if (song.py && song.py.startsWith(term)) best = Math.max(best, 700);
        else if (song.py && song.py.includes(term)) best = Math.max(best, 420);
        else if (!noArtistInit && song.ainit && song.ainit.startsWith(term)) best = Math.max(best, 600);
        else if (!noArtistInit && song.apy && song.apy.startsWith(term)) best = Math.max(best, 560);
        else if (!noArtistInit && song.ainit && song.ainit.includes(term)) best = Math.max(best, 380);
      }
      if (!best) return 0;
      total += best;
    }
    // 热度微调：常唱的歌稍微靠前
    total += Math.min(60, Math.log2((song.plays || 0) + 1) * 12);
    return total;
  }

  langFacets() {
    const map = new Map();
    for (const song of this.songs) {
      const key = song.lang || '未分类';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([lang, count]) => ({ lang, count }));
  }

  typeFacets() {
    const map = new Map();
    for (const song of this.songs) {
      const key = song.type || '未分类';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
  }

  close() {
    this.store.close();
  }
}
