import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './util.js';

/**
 * 播放兼容处理（只重封装，不转视频）。
 *
 * 背景：KTV 片源绝大多数是 **MP2（MPEG Layer 2）音频**，安卓平台的解码器只支持 MP3 层，
 * 浏览器也不认 MP2，直接播就会 DECODER_INIT_FAILED / 黑屏。
 * 视频则基本都是 H.264（mkv）或 MPEG-2（mpg），设备本身能硬解，**完全不需要转码**。
 *
 * 所以这里的策略是：
 *   视频 -c:v copy（永远不转码，J1900 也能瞬间完成）
 *   音频 -c:a copy（本来就 AAC 时）或 -c:a aac（MP2 等设备解不了的，转 AAC 开销极小）
 *   容器 mkv/mpg -> mp4/fMP4（浏览器）或 mpegts（投影仪播 MPEG-2）
 *
 * 每个歌曲+音轨只处理一次，结果落缓存，之后秒开。
 */
const AUDIO_DIRECT = new Set(['aac', 'mp3']); // 原文件里就能直接出的
const WEB_VIDEO_OK = new Set(['h264']); // 浏览器能解的
const APK_VIDEO_OK = new Set(['h264', 'hevc', 'mpeg2video', 'mpeg1video']); // 投影仪（ExoPlayer/硬解）
const MP4_VIDEO = new Set(['h264', 'hevc']); // 能塞进 mp4 容器的
const WEB_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

export class Remuxer {
  constructor(cfg) {
    this.cfg = cfg;
    this.jobs = new Map(); // key -> { state, progress, file, error, promise }
    this.queue = [];
    this.running = 0;
    this.maxRunning = 1;
  }

  /* ---------------- 播放方案判定 ---------------- */

  /**
   * @returns {{kind:'direct'} |
   *           {kind:'remux', container:'mp4'|'ts', audioCopy:boolean} |
   *           {kind:'unsupported', reason:string}}
   */
  decide(song, track = 0, client = 'web', { forceCompat = false } = {}) {
    const ext = path.extname(song.file || '').toLowerCase();
    const v = String(song.vcodec || '').toLowerCase();
    const audios = Array.isArray(song.audios) ? song.audios : [];
    const isWeb = client !== 'apk';

    // 还没探测过（快速扫描刚入库）：没法判断，先直出，客户端失败会自动降级到兼容流
    if (!audios.length) return { kind: 'direct' };

    const a = String((audios[track] || audios[0] || {}).codec || '').toLowerCase();
    const audioDirect = AUDIO_DIRECT.has(a);

    // 纯 MV（无音轨）直接播
    if (!a) return { kind: 'direct' };

    if (isWeb && !WEB_VIDEO_OK.has(v)) {
      const name = v ? v.toUpperCase() : '该';
      return { kind: 'unsupported', reason: `浏览器无法解码 ${name} 视频，请在投影仪上播放` };
    }
    if (!isWeb && !APK_VIDEO_OK.has(v)) {
      const name = v ? v.toUpperCase() : '该';
      return { kind: 'unsupported', reason: `投影仪无法解码 ${name} 视频` };
    }

    const containerDirect = isWeb ? WEB_CONTAINERS.has(ext) : true;
    if (!forceCompat && audioDirect && containerDirect) return { kind: 'direct' };

    return {
      kind: 'remux',
      container: MP4_VIDEO.has(v) ? 'mp4' : 'ts',
      audioCopy: a === 'aac', // mp3 塞 mp4 兼容性不稳，统一走 aac
    };
  }

  cacheFile(songId, track, container = 'mp4') {
    return path.join(this.cfg.cacheDir, `${songId}_a${track}.${container === 'ts' ? 'ts' : 'mp4'}`);
  }

  /** 给前端看的状态：ready / queued / running / unsupported / none */
  status(song, track, client = 'web', opts = {}) {
    const plan = this.decide(song, track, client, opts);
    const url = `/stream/${song.id}?track=${track}&client=${client}${opts.forceCompat ? '&compat=1' : ''}`;
    if (plan.kind === 'direct') return { state: 'ready', direct: true, progress: 100, url };
    if (plan.kind === 'unsupported') return { state: 'unsupported', progress: 0, url, error: plan.reason };

    const file = this.cacheFile(song.id, track, plan.container);
    const job = this.jobs.get(file);
    if (job && job.state !== 'ready') {
      return { state: job.state, progress: job.progress || 0, url, error: job.error, container: plan.container };
    }
    if (fs.existsSync(file)) return { state: 'ready', progress: 100, url, container: plan.container };
    return { state: 'none', progress: 0, url, container: plan.container };
  }

  /**
   * 预热：点歌进队列后就在后台把这一首准备成"随时可播"。
   * 用投影仪能力判定（产出的 mp4/ts 浏览器也能用），失败不抛给调用方。
   */
  warm(song, track = 0) {
    if (!this.cfg.allowRemux) return Promise.resolve(null);
    const plan = this.decide(song, track, 'apk');
    if (plan.kind !== 'remux') return Promise.resolve(null);
    return this.ensure(song, track, 'apk').catch(() => null);
  }

  ensure(song, track = 0, client = 'web', opts = {}) {    // 总开关：关掉后完全不碰文件（能直出就直出，不能直出由调用方给出明确提示）
    if (!this.cfg.allowRemux) return Promise.reject(new Error('compat-disabled'));

    const plan = this.decide(song, track, client, opts);
    if (plan.kind === 'direct') return Promise.resolve(song.file);
    if (plan.kind === 'unsupported') return Promise.reject(new Error(plan.reason));

    const file = this.cacheFile(song.id, track, plan.container);
    if (fs.existsSync(file)) return Promise.resolve(file);

    const existing = this.jobs.get(file);
    if (existing && existing.promise) return existing.promise;

    const job = { state: 'queued', progress: 0, file, song, track, plan };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise.catch(() => {}); // 避免未处理的 rejection 警告
    this.jobs.set(file, job);
    this.queue.push(job);
    this.pump();
    return job.promise;
  }

  /* ---------------- 执行 ---------------- */

  pump() {
    while (this.running < this.maxRunning && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      this.run(job).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  async run(job) {
    const { song, track, file, plan } = job;
    job.state = 'running';
    job.progress = 0;
    const duration = song.duration || 0;

    const vcodec = String(song.vcodec || '').toLowerCase();
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-i', song.file,
      '-map', '0:v:0', '-map', `0:a:${track}`,
      '-sn', '-dn', '-map_metadata', '-1',
      '-c:v', 'copy', // 视频永远不转码
    ];
    if (plan.audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

    if (plan.container === 'ts') args.push('-f', 'mpegts');
    else {
      if (vcodec === 'hevc') args.push('-tag:v', 'hvc1');
      args.push('-movflags', '+faststart');
    }
    args.push('-progress', 'pipe:1', '-nostats', file);

    try {
      await new Promise((resolve, reject) => {
        const proc = spawn(this.cfg.ffmpeg, args, { windowsHide: true });
        let errBuf = '';
        let buf = '';
        proc.stdout.on('data', (chunk) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const m = line.match(/^out_time_us=(\d+)/) || line.match(/^out_time_ms=(\d+)/);
            if (m && duration > 0) {
              const sec = Number(m[1]) / 1e6;
              job.progress = Math.max(job.progress, Math.min(99, Math.round((sec / duration) * 100)));
            }
          }
        });
        proc.stderr.on('data', (c) => { errBuf += c.toString(); });
        const timer = setTimeout(() => proc.kill('SIGKILL'), 30 * 60 * 1000);
        proc.on('error', (err) => { clearTimeout(timer); reject(err); });
        proc.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(errBuf.trim().split('\n').slice(-2).join(' ') || `ffmpeg exit ${code}`));
        });
      });

      job.state = 'ready';
      job.progress = 100;
      job.resolve(file);
      log(`[compat] 完成：${song.title} 音轨${track + 1}（${plan.container}${plan.audioCopy ? '' : '，音频转AAC'}）`);
      this.evict();
    } catch (err) {
      job.state = 'error';
      job.error = `重封装失败：${err.message.slice(0, 160)}`;
      try { await fsp.unlink(file); } catch {}
      job.reject(err);
      log(`[compat] 失败：${song.title} - ${err.message.slice(0, 200)}`);
    }
  }

  /** 缓存超限时按最久未访问清理 */
  async evict() {
    const limit = (this.cfg.cacheMaxGB || 20) * 1024 ** 3;
    let entries;
    try {
      entries = await fsp.readdir(this.cfg.cacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    let total = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(mp4|ts)$/.test(entry.name)) continue;
      const full = path.join(this.cfg.cacheDir, entry.name);
      try {
        const st = await fsp.stat(full);
        files.push({ full, size: st.size, at: st.atimeMs });
        total += st.size;
      } catch {}
    }
    if (total <= limit) return;
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (total <= limit * 0.8) break;
      try {
        await fsp.unlink(f.full);
        total -= f.size;
        log(`[cache] 清理 ${path.basename(f.full)}`);
      } catch {}
    }
  }

  async stats() {
    let count = 0;
    let size = 0;
    try {
      const entries = await fsp.readdir(this.cfg.cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(mp4|ts)$/.test(entry.name)) continue;
        try {
          const st = await fsp.stat(path.join(this.cfg.cacheDir, entry.name));
          count++;
          size += st.size;
        } catch {}
      }
    } catch {}
    return { count, size, active: this.jobs.size };
  }

  async clear() {
    try {
      const entries = await fsp.readdir(this.cfg.cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(mp4|ts)$/.test(entry.name)) {
          try { await fsp.unlink(path.join(this.cfg.cacheDir, entry.name)); } catch {}
        }
      }
    } catch {}
  }
}
