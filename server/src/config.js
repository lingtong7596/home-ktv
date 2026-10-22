import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_CONFIG = {
  port: 9188,
  host: '0.0.0.0',
  roomName: '客厅',
  // 曲库目录：飞牛 NAS 上存放 KTV 视频的路径，可配置多个（本地盘 + 网盘可混用）
  mediaDirs: [],
  dataDir: './data',
  cacheDir: './cache',
  // 转码缓存上限（GB），超出后按最久未使用清理
  cacheMaxGB: 30,
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  // 并发探测数：网盘（CD2/115）建议 2~4，本地盘可到 6~8。J1900 建议不超过 4
  probeConcurrency: 4,
  // 单文件探测超时（毫秒）：网盘读取慢，给足时间
  probeTimeout: 45000,
  // 文件名解析顺序：artist-title（歌手 - 歌名）或 title-artist（歌名 - 歌手）
  filenameOrder: 'artist-title',
  // 全局默认音轨（单曲可通过 origTrack/accTrack 覆盖）。0=第一条音轨
  originalTrack: 0,
  accompanimentTrack: 1,
  // 点歌后提前 remux，H5 播放时秒开（APK 直接播原文件，不需要）
  remuxOnQueue: false,
  // 点歌即预热：歌曲一进队列就在后台读文件头 + 判定/准备播放兼容流，
  // 这样上一首唱完时下一首已经就绪，切歌零等待。已点列表里能看到进度。
  prewarm: true,
  // 播放兼容处理：视频永远 -c:v copy（不转码），只在设备解不了音频时
  // （KTV 片源常见 MP2，安卓/浏览器都不支持）把音频转 AAC，并换成设备能读的容器。
  // 关掉后：设备能解的片源照常直出，解不了的会明确报错而不是空转。
  allowRemux: true,
  // 配置结构版本，用于把老配置文件里的 allowRemux=false 迁移成新语义
  compatVersion: 2,
  // 配置结构版本（v3：默认开启「禁止重复点歌」+ 点歌即预热）
  configVersion: 3,
  // 扫描时是否逐首 ffprobe 读音轨信息。默认关闭（只解析文件名，分钟级完成）；
  // 关闭时音轨信息在歌曲首次点唱时才补读那一个文件的文件头（约 2-3 秒）
  deepScan: false,
  // 自动播放：off=不自动 random=空闲时随机放 favs=空闲时放收藏歌曲
  autoplayMode: 'off',
  // 禁止重复点歌（同一首歌已在待播队列中时，再次点歌将被拒绝）
  // 家庭场景默认开启：同一首歌重复排队只会互相打断，界面会直接显示"已点"
  noRepeat: true,
  autoScanOnStart: false,
  videoExts: ['.mkv', '.mp4', '.avi', '.ts', '.mpg', '.mpeg', '.wmv', '.flv', '.mov', '.m2ts', '.rmvb', '.vob'],
  // 扫描时忽略的目录名
  ignoreDirs: ['@eaDir', '#recycle', '.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information', '@tmp'],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 配置文件落在数据目录（NAS 上是 @appdata/ktv，随应用数据保留，升级不丢）
const CONFIG_DIR = process.env.KTV_DATA_DIR ? path.resolve(process.env.KTV_DATA_DIR) : path.join(ROOT, 'data');
const configFile = path.join(CONFIG_DIR, 'config.json');

/**
 * 配置优先级：环境变量 > config.json > 默认值
 * fpk 安装时通过 cmd/main 注入 KTV_* 环境变量，把数据落到 @appdata 下。
 */
export function loadConfig() {
  const stored = readJson(configFile) || {};
  const cfg = { ...DEFAULT_CONFIG, ...stored };
  // v2 迁移：老配置里 allowRemux=false（当时是"完全不碰文件"），
  // 但那样 MP2 片源在投影仪/浏览器上都播不了。新语义默认开启，这里强制改一次。
  let migrated = false;
  if (stored.compatVersion !== DEFAULT_CONFIG.compatVersion) {
    cfg.allowRemux = true;
    cfg.compatVersion = DEFAULT_CONFIG.compatVersion;
    migrated = true;
  }
  // v3 迁移：老配置里 noRepeat 默认是 false（当时没有这个习惯），
  // 家庭场景重复排队只会互相打断，统一改成默认开启
  if (stored.configVersion !== DEFAULT_CONFIG.configVersion) {
    cfg.noRepeat = true;
    cfg.prewarm = true;
    cfg.configVersion = DEFAULT_CONFIG.configVersion;
    migrated = true;
  }

  const env = process.env;
  if (env.KTV_PORT) cfg.port = Number(env.KTV_PORT) || cfg.port;
  if (env.KTV_HOST) cfg.host = env.KTV_HOST;
  if (env.KTV_DATA_DIR) cfg.dataDir = env.KTV_DATA_DIR;
  if (env.KTV_CACHE_DIR) cfg.cacheDir = env.KTV_CACHE_DIR;
  if (env.KTV_FFMPEG) cfg.ffmpeg = env.KTV_FFMPEG;
  if (env.KTV_FFPROBE) cfg.ffprobe = env.KTV_FFPROBE;
  if (env.KTV_MEDIA_DIRS) {
    cfg.mediaDirs = env.KTV_MEDIA_DIRS.split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  }
  if (env.KTV_PROBE_CONCURRENCY) cfg.probeConcurrency = Number(env.KTV_PROBE_CONCURRENCY) || cfg.probeConcurrency;

  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.cacheDir = path.resolve(ROOT, cfg.cacheDir);
  cfg.publicDir = path.join(ROOT, 'public');
  cfg.mediaDirs = (cfg.mediaDirs || []).map((d) => (path.isAbsolute(d) ? d : path.resolve(ROOT, d)));
  for (const dir of [cfg.dataDir, cfg.cacheDir]) fs.mkdirSync(dir, { recursive: true });
  if (migrated) {
    try { saveConfig(cfg); } catch { /* 只读目录时忽略，运行时仍用新值 */ }
  }
  return cfg;
}

export function saveConfig(cfg) {
  const { publicDir, ...rest } = cfg;
  fs.writeFileSync(configFile, JSON.stringify(rest, null, 2), 'utf8');
}
