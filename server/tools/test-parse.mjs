/**
 * 解析器验证：用真实文件名 + 边界用例逐条比对期望值
 * 运行：node tools/test-parse.mjs
 */
import { parseMediaName } from '../src/parse.js';

const ROOT = '/vol1/1000/ktv歌库';

const cases = [
  // ---- 你的真实样本（7 条）----
  { f: `${ROOT}/周杰伦/周杰伦-爱情悬崖-国语-流行.mkv`, artist: '周杰伦', title: '爱情悬崖', lang: '国语', type: '流行' },
  { f: `${ROOT}/安七炫/安七炫-面具-国语-流行.mkv`, artist: '安七炫', title: '面具', lang: '国语', type: '流行' },
  { f: `${ROOT}/爱乐团/爱乐团-天涯-国语-流行.mkv`, artist: '爱乐团', title: '天涯', lang: '国语', type: '流行' },
  { f: `${ROOT}/陈楚生/陈楚生-一个人的冬天-国语-流行.mkv`, artist: '陈楚生', title: '一个人的冬天', lang: '国语', type: '流行' },
  { f: `${ROOT}/老狼&痛仰乐队/老狼&痛仰乐队-迪亚-国语-流行.mkv`, artist: '老狼 & 痛仰乐队', title: '迪亚', lang: '国语', type: '流行', aliases: ['老狼', '痛仰乐队'] },
  { f: `${ROOT}/白冰 胡歌/白冰 胡歌-美丽的神话-国语-合唱.mpg`, artist: '白冰 & 胡歌', title: '美丽的神话', lang: '国语', type: '合唱', aliases: ['白冰', '胡歌'] },
  { f: `${ROOT}/单依纯_VaVa毛衍七_吴宣仪_群星/单依纯_VaVa毛衍七_吴宣仪_群星-VVS-国语-合唱.mkv`, artist: '单依纯 & VaVa毛衍七 & 吴宣仪 & 群星', title: 'VVS', lang: '国语', type: '合唱', aliases: ['单依纯', 'VaVa毛衍七', '吴宣仪', '群星'] },

  // ---- 边界用例（13 条）----
  // 歌名自带 "-"，不能被切碎
  { f: `${ROOT}/陈奕迅/陈奕迅-十年-粤语版-粤语-流行.mkv`, artist: '陈奕迅', title: '十年-粤语版', lang: '粤语', type: '流行', note: '歌名含连字符' },
  // 只有歌手-歌名
  { f: `${ROOT}/周杰伦/周杰伦-晴天.mkv`, artist: '周杰伦', title: '晴天', lang: '', type: '', note: '无语种类型' },
  // 老式序号命名
  { f: `${ROOT}/周杰伦/001.七里香-国语.mkv`, artist: '周杰伦', title: '七里香', lang: '国语', type: '', note: '序号+仅语种' },
  // 空格分隔
  { f: `${ROOT}/周杰伦/周杰伦 - 爱情悬崖 - 国语 - 流行.mkv`, artist: '周杰伦', title: '爱情悬崖', lang: '国语', type: '流行', note: '空格连字符' },
  // 方括号语种前缀
  { f: `${ROOT}/周杰伦/[国语]周杰伦-晴天.mkv`, artist: '周杰伦', title: '晴天', lang: '国语', type: '', note: '方括号语种' },
  // 书名号
  { f: `${ROOT}/周杰伦/周杰伦《晴天》.mkv`, artist: '周杰伦', title: '晴天', lang: '', type: '', note: '书名号' },
  // 根目录散落文件（无歌手文件夹）
  { f: `${ROOT}/孤勇者.mkv`, artist: '未知歌手', title: '孤勇者', lang: '', type: '', note: '根目录散文件' },
  // 英文歌手带空格，不能被拆碎
  { f: `${ROOT}/Taylor Swift/Taylor Swift-Love Story-英语-流行.mkv`, artist: 'Taylor Swift', title: 'Love Story', lang: '英语', type: '流行', aliases: ['Taylor Swift'], note: '英文名含空格' },
  // 全角连字符
  { f: `${ROOT}/周杰伦/周杰伦－晴天－国语－流行.mkv`, artist: '周杰伦', title: '晴天', lang: '国语', type: '流行', note: '全角连字符' },
  // 歌名含数字与英文
  { f: `${ROOT}/周杰伦/周杰伦-三年二班-国语-流行.mkv`, artist: '周杰伦', title: '三年二班', lang: '国语', type: '流行' },
  // 对唱
  { f: `${ROOT}/凤凰传奇/凤凰传奇-最炫民族风-国语-对唱.mkv`, artist: '凤凰传奇', title: '最炫民族风', lang: '国语', type: '对唱' },
  // 只有歌名-语种-类型（无歌手段，歌手取文件夹）
  { f: `${ROOT}/王菲/红豆-国语-流行.mkv`, artist: '王菲', title: '红豆', lang: '国语', type: '流行', note: '歌手只在文件夹' },
  // 噪声后缀
  { f: `${ROOT}/周杰伦/周杰伦-晴天-国语-流行-1080P.mkv`, artist: '周杰伦', title: '晴天', lang: '国语', type: '流行', note: '带分辨率噪声' },
];

let pass = 0;
const rows = [];

for (const c of cases) {
  const r = parseMediaName(c.f, { rootDir: ROOT });
  const checks = [];
  const chk = (name, got, want) => {
    if (want === undefined) return true;
    const ok = String(got) === String(want);
    checks.push({ name, got, want, ok });
    return ok;
  };
  chk('歌手', r.artist, c.artist);
  chk('歌名', r.title, c.title);
  chk('语种', r.lang, c.lang);
  chk('类型', r.type, c.type);
  if (c.aliases) chk('别名', r.artists.join('|'), c.aliases.join('|'));

  const ok = checks.every((x) => x.ok);
  if (ok) pass++;
  rows.push({ c, r, checks, ok });
}

/* ---------- 输出 ---------- */
console.log('\n### 一、解析结果总表\n');
console.log('| # | 文件名 | 歌手 | 歌名 | 语种 | 类型 | 判定 |');
console.log('|---|---|---|---|---|---|---|');
rows.forEach(({ c, r, ok }, i) => {
  const base = c.f.split('/').pop();
  console.log(`| ${i + 1} | \`${base}\` | ${r.artist} | ${r.title} | ${r.lang || '—'} | ${r.type || '—'} | ${ok ? '✅' : '❌'} |`);
});

const fails = rows.filter((x) => !x.ok);
if (fails.length) {
  console.log('\n### 二、未通过的用例（字段级比对）\n');
  for (const { c, checks } of fails) {
    console.log(`**${c.f.split('/').pop()}** ${c.note ? `（${c.note}）` : ''}`);
    for (const x of checks.filter((y) => !y.ok)) {
      console.log(`  - ${x.name}: 得到 \`${x.got}\` ≠ 期望 \`${x.want}\``);
    }
    console.log('');
  }
}

console.log(`\n### 三、统计\n`);
console.log(`用例 ${cases.length} 条，通过 **${pass}** 条，失败 **${cases.length - pass}** 条。`);
process.exit(fails.length ? 1 : 0);
