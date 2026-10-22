import { DatabaseSync } from 'node:sqlite';
import { Library } from '../src/library.js';
import { loadConfig } from '../src/config.js';

const cfg = loadConfig();
console.log('dataDir', cfg.dataDir);

// 模拟老库：清空 artists 表（老版本没有这张表的数据）
const raw = new DatabaseSync(cfg.dataDir + '/ktv.db');
raw.exec('DELETE FROM artists');
console.log('after delete artists rows =', raw.prepare('SELECT COUNT(*) n FROM artists').get().n);
console.log('songs =', raw.prepare('SELECT COUNT(*) n FROM songs').get().n);
raw.close();

const lib = new Library(cfg);
console.log('songs loaded =', lib.songs.length);
console.log('artists rebuilt =', lib.artists.length);
console.log('top5 =', lib.artists.slice(0, 5).map((a) => `${a.name}(${a.count})`).join(', '));
console.log('sample py =', lib.artists[0].py, '/', lib.artists[0].init);
const letter = (lib.artists[0].init || 'A')[0].toUpperCase();
const l = lib.listArtists({ letter });
console.log('letter', letter, 'hits =', l.length);
