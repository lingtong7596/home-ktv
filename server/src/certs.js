import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './util.js';

const pExec = promisify(execFile);

/**
 * 手机麦克风打分（getUserMedia）只能在「安全上下文」里跑。局域网没有 CA 签发的域名，
 * 只能自己当一次 CA：首次启动生成一张本地根证书（可装到手机），再用它签一张
 * 带 IP SAN 的服务端证书挂 9189。
 *
 * 为什么不能只做「自签证书 + 点继续访问」：证书报错的页面在 Chrome 里
 * isSecureContext === false、navigator.mediaDevices 直接不存在，麦克风永远打不开。
 * 必须让手机信任这张根证书（下载 ktv-ca.crt 装一次，10 年有效）。
 */

function sanFor(ips) {
  const list = new Set(['127.0.0.1', 'localhost', 'home-ktv.local', ...ips]);
  return [...list]
    .filter(Boolean)
    .map((x) => (/^\d+\.\d+\.\d+\.\d+$/.test(x) ? `IP:${x}` : `DNS:${x}`))
    .join(',');
}

function localIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list || []) {
      if (it && it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

export async function ensureCerts(dataDir, extraIps = []) {
  const dir = path.join(dataDir, 'certs');
  fs.mkdirSync(dir, { recursive: true });

  const caKeyFile = path.join(dir, 'ktv-ca.key');
  const caFile = path.join(dir, 'ktv-ca.pem');
  const keyFile = path.join(dir, 'ktv-key.pem');
  const certFile = path.join(dir, 'ktv-cert.pem');
  const sanFile = path.join(dir, 'ktv-cert.san');

  const san = sanFor([...extraIps, ...localIps()]);
  const has = (f) => fs.existsSync(f);

  // 已有且地址没变就复用（换网段要重签，否则浏览器报 IP 不匹配）
  if (has(caFile) && has(caKeyFile) && has(keyFile) && has(certFile) && has(sanFile) &&
      fs.readFileSync(sanFile, 'utf8').trim() === san) {
    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile, 'utf8') + fs.readFileSync(caFile, 'utf8'),
    };
  }

  try {
    // 1) 本地根证书（10 年，手机装一次）
    if (!has(caFile) || !has(caKeyFile)) {
      await pExec('openssl', [
        'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '3650',
        '-subj', '/CN=HomeKTV Local CA/O=Home KTV', '-keyout', caKeyFile, '-out', caFile,
      ]);
      log('[https] 已生成本地根证书 data/certs/ktv-ca.pem（装到手机上即可消除警告）');
    }

    // 2) 服务端证书：由根证书签发，带 IP SAN
    await pExec('openssl', [
      'req', '-new', '-newkey', 'rsa:2048', '-nodes',
      '-subj', '/CN=home-ktv', '-keyout', keyFile, '-out', path.join(dir, 'ktv.csr'),
    ]);
    const extFile = path.join(dir, 'ktv-cert.ext');
    fs.writeFileSync(extFile, [
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`,
      '',
    ].join('\n'));
    await pExec('openssl', [
      'x509', '-req', '-in', path.join(dir, 'ktv.csr'),
      '-CA', caFile, '-CAkey', caKeyFile, '-CAcreateserial',
      '-days', '825', '-out', certFile, '-extfile', extFile,
    ], { cwd: dir });
    fs.writeFileSync(sanFile, san + '\n');
    log(`[https] 已签发服务端证书（825 天）SAN=${san}`);
    return {
      key: fs.readFileSync(keyFile),
      cert: fs.readFileSync(certFile, 'utf8') + fs.readFileSync(caFile, 'utf8'),
    };
  } catch (err) {
    log('[https] 生成证书失败（找不到 openssl？），手机打分将不可用:', err.message);
    return null;
  }
}

/** 根证书路径（手机下载安装用） */
export function caPemPath(dataDir) {
  const f = path.join(dataDir, 'certs', 'ktv-ca.pem');
  return fs.existsSync(f) ? f : '';
}
