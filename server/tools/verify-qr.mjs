// 仅用于开发期校验：把自研二维码矩阵与 npm qrcode 官方实现逐位比对
import { qrMatrix } from '../src/qr.js';
import QRCode from 'qrcode';

const samples = [
  'http://192.168.1.100:8080/m/?room=living',
  'http://192.168.1.100:8080/m/',
  'http://fnos.local:8080/m/?room=ktv',
];
let pass = 0, fail = 0;
for (const text of samples) {
  for (const ecl of ['L', 'M', 'Q', 'H']) {
    for (let mask = 0; mask < 8; mask++) {
      const mine = qrMatrix(text, { ecl, mask });
      // 强制参考实现也使用「纯 byte 模式」，否则它会自动分段（Byte+Alphanumeric），矩阵必然不同
      const ref = QRCode.create([{ data: text, mode: 'byte' }], { errorCorrectionLevel: ecl, maskPattern: mask, version: mine.version });
      const refSize = ref.modules.size;
      let diff = 0;
      if (refSize !== mine.size) { diff = -1; }
      else {
        for (let r = 0; r < refSize; r++) {
          for (let c = 0; c < refSize; c++) {
            if (!!ref.modules.get(r, c) !== !!mine.modules[r][c]) diff++;
          }
        }
      }
      if (diff === 0) pass++;
      else { fail++; if (fail <= 12) { const rows = new Set(); for (let r = 0; r < refSize; r++) for (let c = 0; c < refSize; c++) if (!!ref.modules.get(r, c) !== !!mine.modules[r][c]) rows.add(r); console.log(`FAIL ecl=${ecl} mask=${mask} v=${mine.version} diff=${diff} rows=${[...rows].slice(0, 12).join(',')}`); } }
    }
  }
}
console.log(`pass=${pass} fail=${fail}`);
