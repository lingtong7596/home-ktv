/**
 * 下载并解包 fpk 所需的 Linux x86_64 运行时：
 *   runtime/node/bin/node          (Node.js v22 官方 linux-x64, tar.xz)
 *   runtime/ffmpeg/ffmpeg|ffprobe  (ffmpeg-static b6.0 静态构建, npmmirror 镜像 .gz)
 *
 * 解压使用系统 Python 标准库（tarfile/lzma/gzip），无需安装任何东西。
 * 幂等：产物已存在时跳过对应步骤。
 *
 * 源选择说明：
 *  - nodejs.org 国内可达，速度正常
 *  - johnvansickle.com / GitHub BtbN 实测慢或不可达，ffmpeg-static 的
 *    npmmirror 二进制镜像速度最快，且与 johnvansickle 同为静态构建
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNTIME = path.join(HOME, 'fpk', 'runtime');
const DL = path.join(RUNTIME, '_dl');
const PY = process.env.KTV_PYTHON || 'python';

const NODE_VER = 'v22.22.2';
const NODE_URL = `https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz`;
const FFMPEG_BASE = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.0';

const log = (m) => console.log(`[runtime] ${m}`);

function download(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) {
    log(`已存在，跳过下载: ${path.basename(dest)}`);
    return;
  }
  log(`下载 ${url}`);
  execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
}

function py(script) {
  execFileSync(PY, ['-c', script], { stdio: 'inherit' });
}

fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(DL, { recursive: true });

/* ---------- Node ---------- */
const nodeBin = path.join(RUNTIME, 'node', 'bin', 'node');
if (fs.existsSync(nodeBin)) {
  log('Node 运行时已就绪');
} else {
  const archive = path.join(DL, 'node.tar.xz');
  download(NODE_URL, archive);
  log('解压 Node…');
  py([
    `import tarfile, os`,
    `os.makedirs(r'${path.join(RUNTIME, 'node', 'bin').replace(/\\/g, '/').replaceAll("'", "\\'")}', exist_ok=True)`,
    `with tarfile.open(r'${archive.replace(/\\/g, '/')}') as t:`,
    `    m = [x for x in t.getmembers() if x.name.endswith('/bin/node')][0]`,
    `    m.name = 'node'`,
    `    t.extract(m, r'${path.join(RUNTIME, 'node', 'bin').replace(/\\/g, '/')}')`,
    `os.chmod(r'${nodeBin.replace(/\\/g, '/')}', 0o755)`,
  ].join('\n'));
  log(`node -> ${nodeBin} (${(fs.statSync(nodeBin).size / 1024 / 1024).toFixed(1)} MB)`);
}

/* ---------- ffmpeg ---------- */
const ffmpegBin = path.join(RUNTIME, 'ffmpeg', 'ffmpeg');
const ffprobeBin = path.join(RUNTIME, 'ffmpeg', 'ffprobe');
if (fs.existsSync(ffmpegBin) && fs.existsSync(ffprobeBin)) {
  log('ffmpeg 运行时已就绪');
} else {
  fs.mkdirSync(path.join(RUNTIME, 'ffmpeg'), { recursive: true });
  for (const [name, dest] of [
    ['ffmpeg-linux-x64.gz', ffmpegBin],
    ['ffprobe-linux-x64.gz', ffprobeBin],
  ]) {
    const gz = path.join(DL, name);
    download(`${FFMPEG_BASE}/${name}`, gz);
    py([
      `import gzip, shutil, os`,
      `with gzip.open(r'${gz.replace(/\\/g, '/')}','rb') as fi, open(r'${dest.replace(/\\/g, '/')}','wb') as fo:`,
      `    shutil.copyfileobj(fi, fo)`,
      `os.chmod(r'${dest.replace(/\\/g, '/')}', 0o755)`,
    ].join('\n'));
    log(`${name} -> ${dest}`);
  }
}

fs.rmSync(DL, { recursive: true, force: true });
log('全部运行时就绪');
