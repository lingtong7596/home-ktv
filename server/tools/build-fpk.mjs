/**
 * 家庭 KTV fpk 打包脚本 v2 —— 使用官方 fnpack 工具打包
 *
 * 结构遵循 https://developer.fnnas.com/docs/cli/fnpack/ 的标准项目布局：
 *   <stage>/
 *   ├── app/            应用运行文件（打包为 app.tgz，含 ui/）
 *   ├── cmd/            生命周期脚本
 *   ├── config/         privilege / resource
 *   ├── wizard/         空目录（无需向导；曲库路径在 /admin 后台配置）
 *   ├── manifest
 *   ├── ICON.PNG
 *   └── ICON_256.PNG
 *
 * 前置：官方 fnpack（Windows 二进制），默认路径 FNPACK 环境变量或
 *       E:/ktv-build/fnpack/fnpack.exe，下载地址见 docs。
 *
 * 用法： node tools/build-fpk.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FPK_DIR = path.join(HOME, 'fpk');
const SERVER_DIR = path.join(HOME, 'server');
const RUNTIME_DIR = path.join(FPK_DIR, 'runtime');
const STAGE = path.join(FPK_DIR, '.stage', 'ktv');
const FNPACK = process.env.FNPACK || 'E:/ktv-build/fnpack/fnpack.exe';

function log(msg) {
  console.log(`[fpk] ${msg}`);
}
function die(msg) {
  console.error(`[fpk] ERROR: ${msg}`);
  process.exit(1);
}

/* ---------- 0. 前置检查 ---------- */
if (!fs.existsSync(FNPACK)) {
  die(`未找到官方 fnpack: ${FNPACK}\n  下载: https://developer.fnnas.com/docs/cli/fnpack/ （设 FNPACK 环境变量）`);
}
for (const req of ['manifest', 'cmd', 'config', 'ui', 'ICON.PNG', 'ICON_256.PNG']) {
  if (!fs.existsSync(path.join(FPK_DIR, req))) die(`缺少 ${req}`);
}
const nodeBin = path.join(RUNTIME_DIR, 'node', 'bin', 'node');
if (!fs.existsSync(nodeBin)) die(`缺少 Node 运行时: ${nodeBin}（先运行 tools/fetch-runtime.mjs）`);
const ffmpegBin = path.join(RUNTIME_DIR, 'ffmpeg', 'ffmpeg');
const ffprobeBin = path.join(RUNTIME_DIR, 'ffmpeg', 'ffprobe');
if (!fs.existsSync(ffmpegBin) || !fs.existsSync(ffprobeBin)) die(`缺少 ffmpeg 运行时（先运行 tools/fetch-runtime.mjs）`);

/* ---------- 1. 组装标准项目结构 ---------- */
fs.rmSync(path.join(FPK_DIR, '.stage'), { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// 1a. app/：服务端代码 + 运行时 + 桌面 UI
const appDir = path.join(STAGE, 'app');
fs.mkdirSync(appDir, { recursive: true });

const serverDest = path.join(appDir, 'server');
fs.mkdirSync(serverDest, { recursive: true });
for (const entry of ['server.js', 'package.json', 'src', 'public']) {
  fs.cpSync(path.join(SERVER_DIR, entry), path.join(serverDest, entry), { recursive: true });
}

fs.cpSync(path.join(RUNTIME_DIR, 'node'), path.join(appDir, 'node'), { recursive: true });
fs.cpSync(path.join(RUNTIME_DIR, 'ffmpeg'), path.join(appDir, 'ffmpeg'), { recursive: true });
fs.cpSync(path.join(FPK_DIR, 'ui'), path.join(appDir, 'ui'), { recursive: true });
log('app/ 已组装（server + node + ffmpeg + ui）');

// 1b. 顶层：cmd / config / manifest / ICON
for (const entry of ['cmd', 'config']) {
  fs.cpSync(path.join(FPK_DIR, entry), path.join(STAGE, entry), { recursive: true });
}
fs.cpSync(path.join(FPK_DIR, 'manifest'), path.join(STAGE, 'manifest'));
fs.cpSync(path.join(FPK_DIR, 'ICON.PNG'), path.join(STAGE, 'ICON.PNG'));
fs.cpSync(path.join(FPK_DIR, 'ICON_256.PNG'), path.join(STAGE, 'ICON_256.PNG'));

// 1c. wizard/：必须存在但为空（本应用无需向导）
fs.mkdirSync(path.join(STAGE, 'wizard'), { recursive: true });

// 1d. 统一脚本换行为 LF
const cmdDir = path.join(STAGE, 'cmd');
for (const f of fs.readdirSync(cmdDir)) {
  const file = path.join(cmdDir, f);
  if (fs.statSync(file).isFile()) {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
  }
}

/* ---------- 2. 用官方 fnpack 打包 ---------- */
log('调用官方 fnpack build ...');
// 注意：fnpack 把产物输出到"当前工作目录"，因此 cwd 必须是 stage 目录
execFileSync(FNPACK, ['build', '--directory', STAGE], { stdio: 'inherit', cwd: STAGE });

const built = fs.readdirSync(STAGE).find((f) => f.endsWith('.fpk'));
if (!built) die('fnpack 未产出 .fpk');
const manifestSrc = fs.readFileSync(path.join(FPK_DIR, 'manifest'), 'utf8');
const kv = {};
for (const line of manifestSrc.split(/\r?\n/)) {
  const m = line.match(/^([a-z_]+)\s*=\s*(.*)$/);
  if (m) kv[m[1]] = m[2].trim();
}
const outPath = path.join(FPK_DIR, `ktv_${kv.version}_${kv.platform}.fpk`);
fs.copyFileSync(path.join(STAGE, built), outPath);
fs.rmSync(path.join(FPK_DIR, '.stage'), { recursive: true, force: true });

const size = fs.statSync(outPath).size;
log('==== 打包完成（官方 fnpack 校验通过） ====');
log(`产物: ${outPath}`);
log(`大小: ${(size / 1024 / 1024).toFixed(1)} MB`);
log('安装: 飞牛桌面 -> 应用中心 -> 手动安装');
