import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { log } from './util.js';

const pExec = promisify(execFile);

/**
 * 自签证书：手机麦克风打分（getUserMedia）必须跑在安全上下文（https）里，
 * 局域网又没有 CA 签发的域名，所以首次启动用 NAS 自带的 openssl 生成一张
 * 自签证书，浏览器首次访问会提示"不安全"，用户点「继续访问」即可。
 */
export async function ensureSelfSignedCert(dataDir) {
  const dir = path.join(dataDir, 'certs');
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(dir, 'ktv-key.pem');
  const certFile = path.join(dir, 'ktv-cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  try {
    await pExec('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-subj', '/CN=home-ktv', '-keyout', keyFile, '-out', certFile,
    ]);
    log('[https] 已生成自签证书（data/certs/），有效期 10 年');
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch (err) {
    log('[https] 生成自签证书失败（找不到 openssl？），手机打分将不可用:', err.message);
    return null;
  }
}
