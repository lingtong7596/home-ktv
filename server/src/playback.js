import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, uid, log } from './util.js';

/**
 * 房间播放状态机（服务端是唯一权威）：
 *   current = 正在唱的这首；queue = 已点待唱。
 *   手机点歌 -> 服务器改状态 -> SSE 推给投影仪 -> 投影仪加载视频。
 * 这样投影仪和手机永远看到同一个"房间"，谁断了重连都能自动对齐。
 */
export class Playback {
  constructor(cfg, library, remuxer, hub) {
    this.cfg = cfg;
    this.library = library;
    this.remuxer = remuxer;
    this.hub = hub;
    this.queue = [];
    this.current = null;
    this.history = [];
    this.tokenSeq = 0;
    this.revision = 0;
    /**
     * 原唱/伴唱"状态"记忆（不是音轨号）：
     * 用户切到伴唱后，下一首歌也自动从伴唱开始——各首歌的音轨排列可能不同，
     * 所以记的是角色（orig / acc），每首歌再各自映射到自己的音轨号。
     */
    this.trackRole = 'orig';
    this.stateFile = path.join(cfg.dataDir, 'state.json');
    this.saveTimer = null;
    this.load();

    // 每秒广播一次状态，手机端进度条才顺滑
    setInterval(() => {
      if (this.current && !this.current.paused) this.broadcast();
    }, 1000).unref?.();

    // 空闲自动播放：随机歌曲 / 收藏歌曲（投影仪开着就一直有歌唱）
    setInterval(() => {
      if (!this.current && this.cfg.autoplayMode && this.cfg.autoplayMode !== 'off') {
        this.autoPlay();
      }
    }, 5000).unref?.();

    // 预热进度：有任务在跑时定时推状态，已点列表里能看到"读取中 60%"
    setInterval(() => {
      if (this.current && !this.current.paused) return; // 已在 1s 循环里推
      if (this.hasPendingWarm()) this.broadcast();
    }, 2000).unref?.();
  }

  /* ---------------- 音轨角色 ---------------- */

  /** 把「原唱/伴唱」角色映射成某首歌自己的音轨号 */
  roleTrack(song, role = this.trackRole) {
    const count = song.trackCount || 0;
    if (role === 'acc') {
      if (count < 2) return 0;
      const t = song.accTrack != null ? song.accTrack : this.cfg.accompanimentTrack;
      return t >= 0 && t < count ? t : Math.min(1, count - 1);
    }
    const t = song.origTrack != null ? song.origTrack : this.cfg.originalTrack;
    return t >= 0 && t < count ? t : 0;
  }

  /** 给定音轨号，判断它属于哪个角色（用户手动切轨时用来更新记忆） */
  roleOfTrack(song, track) {
    if ((song.trackCount || 0) < 2) return 'orig';
    return track === this.roleTrack(song, 'acc') ? 'acc' : 'orig';
  }

  /* ---------------- 预热 ---------------- */

  /** 队列里是否还有正在准备/排队的歌曲 */
  hasPendingWarm() {
    const items = [this.current, ...this.queue].filter(Boolean).slice(0, 6);
    for (const item of items) {
      const song = this.library.get(item.songId);
      if (!song) continue;
      const p = this.prepareOf(song);
      if (p.state === 'running' || p.state === 'queued' || p.state === 'probing') return true;
    }
    return false;
  }

  /** 这首歌对投影仪而言的"可播状态"：direct / ready / running / queued / none */
  prepareOf(song) {
    if (!song) return { state: 'none', progress: 0 };
    if (!song.trackCount) {
      if (this.library.probing.has(song.id)) return { state: 'probing', progress: 0, text: '读取中' };
      return { state: 'pending', progress: 0, text: '待读取' };
    }
    if (!this.cfg.allowRemux) {
      const plan = this.remuxer.decide(song, this.roleTrack(song), 'apk');
      return plan.kind === 'direct'
        ? { state: 'ready', progress: 100 }
        : { state: 'off', progress: 0, text: '需兼容处理' };
    }
    const st = this.remuxer.status(song, this.roleTrack(song), 'apk');
    if (st.state === 'ready') return { state: 'ready', progress: 100 };
    if (st.state === 'unsupported') return { state: 'unsupported', progress: 0, text: '不支持的编码' };
    return { state: st.state, progress: st.progress || 0, text: st.state === 'none' ? '待处理' : '处理中' };
  }

  /** 点歌即预热：当前 + 队列前几首在后台把文件头读好、兼容流备好 */
  prewarm() {
    if (!this.cfg.prewarm) return;
    const targets = [this.current, ...this.queue].filter(Boolean).slice(0, 6);
    for (const item of targets) this.warmOne(item);
  }

  warmOne(item) {
    const song = this.library.get(item.songId);
    if (!song) return;
    const run = () => {
      if (!this.cfg.allowRemux) return;
      const track = this.roleTrack(song);
      this.remuxer.warm(song, track).catch(() => {});
    };
    if (!song.trackCount) {
      this.library
        .ensureProbed(song.id)
        .then(() => {
          // 探测前不知道有几条音轨，音轨号只能先给 0；
          // 补到信息后立刻按当前角色（原唱/伴唱）重新定位，避免"切了伴唱却是原唱"
          this.syncTrackOf(song);
          run();
          this.broadcast();
        })
        .catch(() => {});
    } else {
      run();
    }
  }

  /** 探测补齐后，把正在/待播歌曲的音轨号对齐到当前角色 */
  syncTrackOf(song) {
    if (!song || !song.trackCount) return;
    const want = this.roleTrack(song);
    if (this.current && this.current.songId === song.id && this.current.track !== want) {
      this.current.track = want;
      this.current.token = ++this.tokenSeq;
    }
  }

  /** 兼容旧方法名 */
  prefetch() {
    this.prewarm();
  }

  /* ---------------- 播放控制 ---------------- */

  /** 开机/空闲自动播放：按设置的来源随机挑一首未在近期唱过的歌 */
  autoPlay() {
    const mode = this.cfg.autoplayMode;
    const recent = [...(this.current ? [this.current.songId] : []), ...this.history];
    const [pick] = this.library.randomSongs(1, {
      fromFavs: mode === 'favs',
      exclude: recent,
    });
    if (!pick) return;
    this.start(pick, '自动播放');
  }

  /** 重唱：当前歌曲从头再来，不清空队列 */
  replay() {
    if (!this.current) return false;
    this.current.position = 0;
    this.current.positionAt = Date.now();
    this.current.paused = false;
    this.current.token = ++this.tokenSeq;
    this.library.recordPlay(this.current.songId);
    this.bump();
    return true;
  }

  load() {
    const saved = readJson(this.stateFile, null);
    if (!saved) return;
    this.queue = (saved.queue || []).filter((item) => this.library.get(item.songId));
    if (saved.trackRole === 'acc' || saved.trackRole === 'orig') this.trackRole = saved.trackRole;
    if (saved.current && this.library.get(saved.current.songId)) {
      this.current = { ...saved.current, paused: true, token: ++this.tokenSeq };
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        writeJsonAtomic(this.stateFile, {
          queue: this.queue,
          current: this.current,
          trackRole: this.trackRole,
        });
      } catch (err) {
        log('保存状态失败:', err.message);
      }
    }, 600);
  }

  bump() {
    this.revision++;
    this.scheduleSave();
    this.broadcast();
  }

  broadcast() {
    if (this.hub) this.hub.broadcast('state', this.snapshot());
  }

  defaultTrack(song) {
    return this.roleTrack(song);
  }

  snapshot() {
    const { current } = this;
    let cur = null;
    if (current) {
      const song = this.library.get(current.songId);
      if (song) {
        cur = {
          qid: current.qid,
          song: this.library.brief(song),
          track: current.track,
          trackRole: this.roleOfTrack(song, current.track),
          trackCount: song.trackCount,
          audioTracks: song.audios || [],
          paused: current.paused,
          position: current.position || 0,
          positionAt: current.positionAt || Date.now(),
          duration: song.duration || 0,
          token: current.token,
          startedAt: current.startedAt,
          by: current.by || '',
          prepare: this.cfg.allowRemux ? this.prepareOf(song) : { state: 'off' },
          streamUrl: `/stream/${song.id}?track=${current.track}&client=web`,
          // APK 用：播放前先问 /api/prepare?client=apk，需要兼容处理时等就绪再拉流
          apkUrl: `/stream/${song.id}?track=${current.track}&client=apk`,
          rawUrl: `/stream/${song.id}?raw=1`,
        };
      }
    }
    return {
      room: this.cfg.roomName,
      revision: this.revision,
      serverTime: Date.now(),
      autoplayMode: this.cfg.autoplayMode || 'off',
      trackRole: this.trackRole,
      noRepeat: !!this.cfg.noRepeat,
      favIds: this.library.favIds,
      current: cur,
      queue: this.queue
        .map((item) => {
          const song = this.library.get(item.songId);
          if (!song) return null;
          return {
            qid: item.qid,
            at: item.at,
            by: item.by,
            prepare: this.prepareOf(song),
            song: this.library.brief(song),
          };
        })
        .filter(Boolean),
      stats: { library: this.library.songs.length },
    };
  }

  start(song, by, { fromPrev = false } = {}) {
    if (this.current) {
      this.history.push(this.current.songId);
      if (this.history.length > 20) this.history.shift();
    }
    this.current = {
      qid: uid(8),
      songId: song.id,
      // 延续上一首的「原唱/伴唱」状态，而不是每首都跳回原唱
      track: this.roleTrack(song),
      paused: false,
      position: 0,
      positionAt: Date.now(),
      token: ++this.tokenSeq,
      startedAt: Date.now(),
      by: by || '',
    };
    this.library.recordPlay(song.id);
    this.prewarm();
    this.bump();
    log(`[play] ${song.artist} - ${song.title}`);
  }

  add(songId, by = '') {
    const song = this.library.get(songId);
    if (!song) throw new Error('歌曲不存在');
    if (this.cfg.noRepeat) {
      if (this.current && this.current.songId === songId) {
        throw new Error('这首歌正在唱，稍等就好');
      }
      const dup = this.queue.find((q) => q.songId === songId);
      if (dup) throw new Error('这首歌已经在已点列表里了');
    }
    if (!this.current) {
      this.start(song, by);
      return { started: true, position: 0 };
    }
    const item = { qid: uid(8), songId, by: by || '', at: Date.now() };
    this.queue.push(item);
    this.prewarm();
    this.bump();
    return { started: false, position: this.queue.findIndex((q) => q.qid === item.qid) + 1 };
  }

  addMany(songIds = [], by = '') {
    const result = [];
    for (const id of songIds) {
      try {
        result.push({ id, ...this.add(id, by), ok: true });
      } catch (err) {
        result.push({ id, ok: false, error: err.message });
      }
    }
    return result;
  }

  next() {
    const item = this.queue.shift();
    if (!item) {
      this.current = null;
      this.bump();
      return null;
    }
    const song = this.library.get(item.songId);
    if (!song) return this.next();
    this.start(song, item.by);
    return song;
  }

  prev() {
    const songId = this.history.pop();
    const song = songId && this.library.get(songId);
    if (!song) return null;
    this.start(song, '上一首', { fromPrev: true });
    return song;
  }

  remove(qid) {
    if (this.current && this.current.qid === qid) {
      this.next();
      return { skipped: true };
    }
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.qid !== qid);
    if (this.queue.length !== before) this.bump();
    return { removed: before - this.queue.length };
  }

  top(qid) {
    const idx = this.queue.findIndex((item) => item.qid === qid);
    if (idx < 0) return false;
    const [item] = this.queue.splice(idx, 1);
    this.queue.unshift(item);
    this.prewarm();
    this.bump();
    return true;
  }

  /** 打乱已点顺序（当前正在唱的不动） */
  shuffle() {
    if (this.queue.length < 2) return false;
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    }
    this.bump();
    return true;
  }

  jumpTo(qid) {
    const idx = this.queue.findIndex((item) => item.qid === qid);
    if (idx < 0) return false;
    const [item] = this.queue.splice(idx, 1);
    const song = this.library.get(item.songId);
    if (!song) return false;
    this.start(song, item.by);
    return true;
  }

  clearQueue() {
    this.queue = [];
    this.bump();
  }

  setTrack(track) {
    if (!this.current) return false;
    const song = this.library.get(this.current.songId);
    if (!song) return false;
    const t = Number(track);
    if (!Number.isInteger(t) || t < 0 || t >= song.trackCount) return false;
    if (this.current.track === t) return false;
    this.current.track = t;
    // 记住这次切的是原唱还是伴唱，下一首继续沿用
    this.trackRole = this.roleOfTrack(song, t);
    // 保留当前进度，切换原唱/伴唱不从头开始
    this.current.position = this.currentPosition();
    this.current.positionAt = Date.now();
    this.current.token = ++this.tokenSeq;
    this.bump();
    return true;
  }

  toggleTrack() {
    if (!this.current) return false;
    const song = this.library.get(this.current.songId);
    if (!song || song.trackCount < 2) return false;
    return this.setTrack(this.trackRole === 'acc' ? this.roleTrack(song, 'orig') : this.roleTrack(song, 'acc'));
  }

  setPaused(paused) {
    if (!this.current) return false;
    this.current.paused = !!paused;
    this.current.positionAt = Date.now();
    this.bump();
    return true;
  }

  seek(seconds) {
    if (!this.current) return false;
    this.current.position = Math.max(0, Number(seconds) || 0);
    this.current.positionAt = Date.now();
    this.bump();
    return true;
  }

  /** 估算当前播放位置（暂停时就是上报值，播放中按时间外推） */
  currentPosition() {
    if (!this.current) return 0;
    if (this.current.paused) return this.current.position || 0;
    const elapsed = (Date.now() - (this.current.positionAt || Date.now())) / 1000;
    return (this.current.position || 0) + elapsed;
  }

  /**
   * 播放器上报真实进度。
   *
   * 注意：这里**故意不接受 paused**。暂停/播放是用户显式指令（/api/player/pause|resume|toggle），
   * 播放器每 2.5 秒的自动上报只用来校准进度。以前会让 paused 参与覆盖，结果
   * "点暂停 -> 上报还在播 -> 服务端改回播放 -> 2 秒后自己又播起来"，
   * 这就是网页端点暂停只能停两秒的根因。
   */
  report({ position, paused, ended }) {
    if (!this.current) return;
    if (ended) {
      this.next();
      return;
    }
    if (typeof position === 'number' && Number.isFinite(position)) {
      this.current.position = position;
      this.current.positionAt = Date.now();
    }
    void paused;
  }

  /** 投影仪重连后用它做对齐：判断是否需要重新加载视频 */
  currentToken() {
    return this.current ? this.current.token : 0;
  }
}
