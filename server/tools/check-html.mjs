// 开发期校验：把页面内联 <script> 抽出来做语法检查，避免手写前端低级错误
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const root = 'new URL("../public", import.meta.url).pathname';
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.html')) files.push(full);
  }
};
walk(root);

let bad = 0;
for (const file of files) {
  const html = fs.readFileSync(file, 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  scripts.forEach((code, i) => {
    const tmp = path.join(os.tmpdir(), `chk_${path.basename(file)}_${i}.mjs`);
    fs.writeFileSync(tmp, code);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      console.log(`OK   ${path.basename(file)} #${i} (${code.length} 字符)`);
    } catch (err) {
      bad++;
      console.log(`FAIL ${path.basename(file)} #${i}\n${err.stderr?.toString() || err.message}`);
    } finally {
      fs.unlinkSync(tmp);
    }
  });
}
console.log(bad ? `\n${bad} 个文件有语法错误` : '\n全部通过');
