// 快捷小窗的纯函数测试：node scripts/test-quick.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Q = require('../src/quickask.js');

let failed = 0;
function ok(name, cond, info) {
  if (cond) console.log('ok -', name);
  else {
    failed++;
    console.error('✗', name, info === undefined ? '' : JSON.stringify(info));
  }
}
const now = 1_000_000;
ok('剪贴板：30 秒内复制的算', Q.recentClip({ text: ' hello ', changedAt: now - 5000 }, now) === 'hello');
ok('剪贴板：超过 30 秒不算', Q.recentClip({ text: 'hello', changedAt: now - 31000 }, now) === '');
ok('剪贴板：启动时已有的不算（changedAt=0）', Q.recentClip({ text: 'hello', changedAt: 0 }, now) === '');
ok('剪贴板：空白不算', Q.recentClip({ text: '   \n', changedAt: now }, now) === '');
ok('剪贴板：太长截断到 6000', Q.recentClip({ text: 'x'.repeat(9000), changedAt: now }, now).length === 6000);

const m1 = Q.buildMessages('翻译成英文', '你好世界', 'zh');
ok('消息：两条（system + user）', m1.length === 2 && m1[0].role === 'system' && m1[1].role === 'user');
ok('消息：引用在问题前面', /引用的内容[\s\S]*你好世界[\s\S]*翻译成英文$/.test(m1[1].content), m1[1].content);
const m2 = Q.buildMessages('  今天几号？ ', '', 'zh');
ok('消息：没有引用时只有问题', m2[1].content === '今天几号？', m2[1].content);
const m3 = Q.buildMessages('', 'Bonjour', 'zh');
ok('消息：只有引用没有问题时注明', /没有具体要求/.test(m3[1].content));
const m4 = Q.buildMessages('Fix grammar', 'he go home', 'en');
ok('消息：英文', /Quoted text/.test(m4[1].content) && /quick assistant/.test(m4[0].content));
ok('快捷键', Q.SHORTCUT === 'CommandOrControl+Shift+Space');

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
