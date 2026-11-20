// 截图裁剪框换算测试：node scripts/test-crop.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { cropRect } = require('../src/screenshot.js');
let failed = 0;
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok -', name);
  else { failed++; console.error(`✗ ${name}\n  期望 ${w}\n  实际 ${g}`); }
}
eq('1 倍屏', cropRect({ x: 10, y: 20, width: 100, height: 50 }, 1, 1920, 1080), { x: 10, y: 20, width: 100, height: 50 });
eq('Retina 2 倍', cropRect({ x: 10, y: 20, width: 100, height: 50 }, 2, 2880, 1800), { x: 20, y: 40, width: 200, height: 100 });
eq('从右下往左上拖', cropRect({ x: 110, y: 70, width: -100, height: -50 }, 2, 2880, 1800), { x: 20, y: 40, width: 200, height: 100 });
eq('1.5 倍取整', cropRect({ x: 10.3, y: 0, width: 33.3, height: 20 }, 1.5, 1920, 1080), { x: 15, y: 0, width: 50, height: 30 });
eq('超出右下边界裁掉', cropRect({ x: 1400, y: 850, width: 200, height: 100 }, 2, 2880, 1800), { x: 2800, y: 1700, width: 80, height: 100 });
eq('超出左上边界裁掉', cropRect({ x: -20, y: -10, width: 50, height: 40 }, 1, 1920, 1080), { x: 0, y: 0, width: 30, height: 30 });
eq('太小返回 null', cropRect({ x: 5, y: 5, width: 1, height: 1 }, 2, 2880, 1800), null);
eq('完全在图外返回 null', cropRect({ x: 3000, y: 10, width: 50, height: 50 }, 1, 1920, 1080), null);
if (failed) { console.error(`\n${failed} 项失败`); process.exit(1); }
console.log('\n全部通过');
