import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function uid(len = 10) {
  return crypto.randomBytes(16).toString('hex').slice(0, len);
}

export function shortHash(text, len = 12) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, len);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免断电/中断造成文件损坏 */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
  fs.renameSync(tmp, file);
}

export function log(...args) {
  const d = new Date();
  const ts = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
  console.log(`[${ts}]`, ...args);
}

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function normalizeQuery(q) {
  return String(q || '').trim().toLowerCase();
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带并发的任务池 */
export async function pool(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        await worker(item);
      } catch (err) {
        log('worker error:', err.message);
      }
    }
  });
  await Promise.all(runners);
}

export function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function hasExt(file, exts) {
  return exts.includes(path.extname(file).toLowerCase());
}
