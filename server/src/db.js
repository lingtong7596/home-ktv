import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { log } from './util.js';

/**
 * 曲库持久层（SQLite）
 *
 * 设计取舍：
 *  - 5000~20000 首规模，SQLite 单文件足够，且支持"扫描时只更新变化行"。
 *  - 检索仍走内存索引（Library 持有 songs 数组），因为中文/拼音模糊打分的
 *    逻辑用 SQL 表达既啰嗦又慢；SQLite 在这里只负责持久化与用户数据（播放次数、
 *    音轨覆盖）的可靠落盘。
 *  - 用户数据（plays/last_played/added_at/orig_track/acc_track）在扫描 upsert 时
 *    **不被覆盖**，避免重扫把点唱记录清空。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  file        TEXT NOT NULL,
  rel         TEXT,
  dir         TEXT,
  name        TEXT,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  artists     TEXT,
  lang        TEXT,
  type        TEXT,
  duration    INTEGER DEFAULT 0,
  width       INTEGER DEFAULT 0,
  height      INTEGER DEFAULT 0,
  vcodec      TEXT,
  audios      TEXT,
  track_count INTEGER DEFAULT 0,
  size        INTEGER DEFAULT 0,
  mtime       INTEGER DEFAULT 0,
  py          TEXT,
  init        TEXT,
  apy         TEXT,
  ainit       TEXT,
  pinit       TEXT,
  plays       INTEGER DEFAULT 0,
  last_played INTEGER DEFAULT 0,
  added_at    INTEGER DEFAULT 0,
  orig_track  INTEGER,
  acc_track   INTEGER,
  probe_ok    INTEGER DEFAULT 0,
  track_guess TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_songs_file  ON songs(file);
CREATE INDEX IF NOT EXISTS idx_songs_title  ON songs(title);
CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist);
CREATE INDEX IF NOT EXISTS idx_songs_init   ON songs(init);
CREATE INDEX IF NOT EXISTS idx_songs_lang   ON songs(lang);
CREATE INDEX IF NOT EXISTS idx_songs_type   ON songs(type);
CREATE INDEX IF NOT EXISTS idx_songs_plays  ON songs(plays DESC);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS favs (
  song_id    TEXT PRIMARY KEY,
  created_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artists (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  py         TEXT,
  init       TEXT,
  region     TEXT DEFAULT '',
  gender     TEXT DEFAULT '',
  updated_at INTEGER DEFAULT 0
);
`;

// 扫描 upsert 时不得覆盖的用户数据
const USER_FIELDS = ['plays', 'last_played', 'added_at', 'orig_track', 'acc_track', 'disabled'];

// 旧库补列（SQLite 无 IF NOT EXISTS 语法，靠异常吞掉）
function ensureColumn(db, table, colDef) {
  const col = colDef.split(/\s+/)[0];
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
  } catch (err) {
    if (!String(err.message).includes('duplicate column')) throw err;
  }
}

export class SongStore {
  constructor(dbFile) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.file = dbFile;
    this.db = new DatabaseSync(dbFile);
    try {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
    } catch {
      /* 某些文件系统不支持 WAL，退化为默认模式 */
    }
    this.db.exec(SCHEMA);
    ensureColumn(this.db, 'songs', 'disabled INTEGER DEFAULT 0');
    this._prepare();
  }

  _prepare() {
    const cols = [
      'id', 'file', 'rel', 'dir', 'name', 'title', 'artist', 'artists', 'lang', 'type',
      'duration', 'width', 'height', 'vcodec', 'audios', 'track_count', 'size', 'mtime',
      'py', 'init', 'apy', 'ainit', 'pinit', 'plays', 'last_played', 'added_at',
      'orig_track', 'acc_track', 'probe_ok', 'track_guess',
    ];
    const placeholders = cols.map(() => '?').join(',');
    const updates = cols
      .filter((c) => c !== 'id' && !USER_FIELDS.includes(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(',');
    this.sqlUpsert = `INSERT INTO songs (${cols.join(',')}) VALUES (${placeholders})
      ON CONFLICT(id) DO UPDATE SET ${updates}`;

    this.stmtUpsert = this.db.prepare(this.sqlUpsert);
    this.stmtAll = this.db.prepare('SELECT * FROM songs');
    this.stmtGet = this.db.prepare('SELECT * FROM songs WHERE id = ?');
    this.stmtCount = this.db.prepare('SELECT COUNT(*) AS n FROM songs');
    this.stmtPlay = this.db.prepare('UPDATE songs SET plays = plays + 1, last_played = ? WHERE id = ?');
    this.stmtOverride = this.db.prepare('UPDATE songs SET orig_track = ?, acc_track = ? WHERE id = ?');
    this.stmtDelete = this.db.prepare('DELETE FROM songs WHERE id = ?');
    this.stmtMeta = this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    this.stmtGetMeta = this.db.prepare('SELECT v FROM meta WHERE k = ?');

    // 停用/启用
    this.stmtDisabled = this.db.prepare('UPDATE songs SET disabled = ? WHERE id = ?');
    // 收藏
    this.stmtFavAdd = this.db.prepare('INSERT OR IGNORE INTO favs (song_id, created_at) VALUES (?, ?)');
    this.stmtFavDel = this.db.prepare('DELETE FROM favs WHERE song_id = ?');
    this.stmtFavAll = this.db.prepare('SELECT song_id, created_at FROM favs ORDER BY created_at DESC');
    this.stmtFavClear = this.db.prepare('DELETE FROM favs');
    // 歌手
    this.stmtArtistUpsert = this.db.prepare(
      'INSERT INTO artists (id, name, py, init, region, gender, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(name) DO UPDATE SET py=excluded.py, init=excluded.init, updated_at=excluded.updated_at',
    );
    this.stmtArtistAll = this.db.prepare('SELECT * FROM artists');
    this.stmtArtistGet = this.db.prepare('SELECT * FROM artists WHERE id = ?');
    this.stmtArtistUpdate = this.db.prepare('UPDATE artists SET region = ?, gender = ?, name = ? WHERE id = ?');
    this.stmtArtistDeleteMissing = this.db.prepare('DELETE FROM artists WHERE id = ?');
  }

  count() {
    return this.stmtCount.get().n;
  }

  all() {
    return this.stmtAll.all().map(rowToSong);
  }

  get(id) {
    const row = this.stmtGet.get(id);
    return row ? rowToSong(row) : null;
  }

  /**
   * 批量写入扫描结果：
   *  - 已存在的行只更新文件元信息，保留 plays / last_played / added_at / 音轨覆盖
   *  - 确认文件已不存在（或在黑名单里）的行才删除；
   *    网盘目录偶发读取不完整时整批保留，避免把曲库误清空
   */
  upsertScan(songs) {
    const now = Date.now();
    let inserted = 0;
    let updated = 0;

    this.db.exec('BEGIN');
    try {
      for (const s of songs) {
        const existed = this.stmtGet.get(s.id);
        this.stmtUpsert.run(
          s.id,
          s.file,
          s.rel ?? null,
          s.dir ?? null,
          s.name ?? null,
          s.title ?? '',
          s.artist ?? '',
          JSON.stringify(s.artists || []),
          s.lang ?? '',
          s.type ?? '',
          s.duration | 0,
          s.width | 0,
          s.height | 0,
          s.vcodec ?? '',
          JSON.stringify(s.audios || []),
          s.trackCount | 0,
          s.size | 0,
          s.mtime | 0,
          s.py ?? '',
          s.init ?? '',
          s.apy ?? '',
          s.ainit ?? '',
          s.pinit ?? '',
          s.plays ?? 0,
          s.lastPlayed ?? 0,
          s.addedAt ?? now,
          s.origTrack ?? null,
          s.accTrack ?? null,
          s.probeOk ? 1 : 0,
          s.trackGuess ?? '',
        );
        if (existed) updated++;
        else inserted++;
      }

      // 清理已删除的文件。
      // ⚠️ 不能简单地"这次没扫到就删"：网盘（CD2/115）偶尔会目录读取失败/超时，
      // 返回一个不完整的列表，按旧逻辑会把整个曲库清空。
      // 所以：小批量缺失才逐个确认文件真的不存在；大面积缺失视为扫描异常，一律保留。
      const keep = new Set(songs.map((s) => s.id));
      const removedSet = new Set(this.removedFiles());
      const existing = this.db.prepare('SELECT id, file FROM songs').all();
      const missing = existing.filter((r) => !keep.has(r.id));
      let removed = 0;
      const suspicious = missing.length > Math.max(50, Math.floor(existing.length * 0.5));
      if (suspicious) {
        log(`[scan] ⚠️ 本次扫描只见到 ${songs.length}/${existing.length} 首，像是目录读取不完整，保留曲库不做清理`);
      }
      for (const { id, file } of missing) {
        if (removedSet.has(file)) {
          this.stmtDelete.run(id);
          removed++;
          continue;
        }
        if (suspicious) continue;
        let gone = true;
        try { gone = !fs.existsSync(file); } catch { gone = false; }
        if (gone) {
          this.stmtDelete.run(id);
          removed++;
        }
      }

      this.stmtMeta.run('last_scan', String(now));
      this.stmtMeta.run('song_count', String(songs.length));
      this.db.exec('COMMIT');
      return { inserted, updated, removed, total: songs.length };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  incPlay(id) {
    this.stmtPlay.run(Date.now(), id);
  }

  setTrackOverride(id, origTrack, accTrack) {
    this.stmtOverride.run(origTrack ?? null, accTrack ?? null, id);
  }

  /** 更新歌曲可编辑字段（后台手工纠正解析结果） */
  updateSongMeta(id, { title, artist, lang, type, py, init, apy, ainit, pinit }) {
    const s = this.get(id);
    if (!s) return false;
    this.db
      .prepare(
        'UPDATE songs SET title=?, artist=?, artists=?, lang=?, type=?, py=?, init=?, apy=?, ainit=?, pinit=? WHERE id=?',
      )
      .run(
        title ?? s.title,
        artist ?? s.artist,
        JSON.stringify(s.artists || []),
        lang ?? s.lang,
        type ?? s.type,
        py ?? s.py,
        init ?? s.init,
        apy ?? s.apy,
        ainit ?? s.ainit,
        pinit ?? s.pinit,
        id,
      );
    return true;
  }

  setDisabled(id, disabled) {
    this.stmtDisabled.run(disabled ? 1 : 0, id);
  }

  /* ---------- 从曲库里移除（后台批量删除） ---------- */

  /**
   * 删除歌曲行，并把文件路径记进"已移除"黑名单。
   * 否则下次扫描又会把同一个文件收回来，用户会觉得"删了还在"。
   */
  removeSongs(ids) {
    const files = [];
    this.db.exec('BEGIN');
    try {
      for (const id of ids) {
        const row = this.stmtGet.get(id);
        if (!row) continue;
        files.push(row.file);
        this.stmtDelete.run(id);
        this.stmtFavDel.run(id);
      }
      const list = this.removedFiles();
      const merged = [...new Set([...list, ...files])];
      this.stmtMeta.run('removed_files', JSON.stringify(merged));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return files;
  }

  removedFiles() {
    const raw = this.getMeta('removed_files');
    if (!raw) return [];
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  restoreFiles(files) {
    const drop = new Set(files);
    const list = this.removedFiles().filter((f) => !drop.has(f));
    this.stmtMeta.run('removed_files', JSON.stringify(list));
    return list;
  }

  /* ---------- 收藏 ---------- */
  favAdd(songId) {
    this.stmtFavAdd.run(songId, Date.now());
  }

  favRemove(songId) {
    this.stmtFavDel.run(songId);
  }

  favAll() {
    return this.stmtFavAll.all();
  }

  favClear() {
    this.stmtFavClear.run();
  }

  /* ---------- 歌手 ---------- */
  upsertArtists(list) {
    this.db.exec('BEGIN');
    try {
      for (const a of list) {
        this.stmtArtistUpsert.run(a.id, a.name, a.py || '', a.init || '', a.region || '', a.gender || '', Date.now());
      }
      // 清掉已经没有歌曲的歌手
      const names = new Set(list.map((a) => a.name));
      for (const row of this.stmtArtistAll.all()) {
        if (!names.has(row.name)) this.stmtArtistDeleteMissing.run(row.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  artistsAll() {
    return this.stmtArtistAll.all().map((r) => ({
      id: r.id,
      name: r.name,
      py: r.py || '',
      init: r.init || '',
      region: r.region || '',
      gender: r.gender || '',
    }));
  }

  artistUpdate(id, { name, region, gender }) {
    const row = this.stmtArtistGet.get(id);
    if (!row) return false;
    this.stmtArtistUpdate.run(region ?? row.region, gender ?? row.gender, name ?? row.name, id);
    return true;
  }

  getMeta(k) {
    const row = this.stmtGetMeta.get(k);
    return row ? row.v : null;
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

function rowToSong(row) {
  return {
    id: row.id,
    file: row.file,
    rel: row.rel,
    dir: row.dir,
    name: row.name,
    title: row.title,
    artist: row.artist,
    artists: safeJson(row.artists, []),
    lang: row.lang || '',
    type: row.type || '',
    duration: row.duration || 0,
    width: row.width || 0,
    height: row.height || 0,
    vcodec: row.vcodec || '',
    audios: safeJson(row.audios, []),
    trackCount: row.track_count || 0,
    size: row.size || 0,
    mtime: row.mtime || 0,
    py: row.py || '',
    init: row.init || '',
    apy: row.apy || '',
    ainit: row.ainit || '',
    pinit: row.pinit || '',
    plays: row.plays || 0,
    lastPlayed: row.last_played || 0,
    addedAt: row.added_at || 0,
    origTrack: row.orig_track,
    accTrack: row.acc_track,
    probeOk: !!row.probe_ok,
    trackGuess: row.track_guess || '',
    disabled: !!(row.disabled | 0),
  };
}

function safeJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function openSongStore(dataDir) {
  return new SongStore(path.join(dataDir, 'ktv.db'));
}
