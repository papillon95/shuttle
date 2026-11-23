// Shuttle 准确率测试题。
// 每道题：setup(dir) 在临时文件夹里生成素材（folder: false 的是纯聊天题，不需要文件夹）；
// prompt 是发给 Shuttle 的话；check({ dir, answer }) 判断做对没有，返回 { pass, reason }。
// 判分只看结果（文件改对了没有、回答里有没有关键信息），不看过程。改代码类的题用藏在素材外面的测试来判，模型改不到。
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const w = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const r = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const ok = (pass, reason = '') => ({ pass: !!pass, reason });
// 在素材文件夹里跑一段 Node 代码（用来调用被改过的模块），返回 stdout
function node(dir, code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim();
}
function nodeCjs(dir, code) {
  return execFileSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }).trim();
}
const tryRun = (fn) => {
  try {
    return { out: fn() };
  } catch (e) {
    return { err: String(e.stderr || e.message).slice(0, 300) };
  }
};
const num = (s) => String(s).replace(/[,，\s]/g, '');

// 生成一个有很多文件的「项目」，用来考搜索：干扰文件里有相似但不同的名字
function fakeProject(dir, n = 60) {
  const mods = ['user', 'order', 'payment', 'invoice', 'product', 'cart', 'auth', 'report', 'notify', 'search'];
  for (let i = 0; i < n; i++) {
    const m = mods[i % mods.length];
    const layer = ['controller', 'service', 'repo', 'util'][i % 4];
    w(dir, `src/${m}/${layer}/${m}${layer[0].toUpperCase() + layer.slice(1)}${i}.js`, `// ${m} ${layer} ${i}\nconst RETRY_DELAY_${i} = ${i * 10};\nfunction ${m}Helper${i}(x) {\n  return x + ${i};\n}\nmodule.exports = { ${m}Helper${i} };\n`);
  }
}

export const tasks = [
  // ---------- 改 bug（藏起来的测试判分） ----------
  {
    id: 'fix-cart',
    category: '改代码',
    prompt: '用户反馈购物车金额有时候算得不对：满 100 减 20 的活动，刚好 100 元时没有减；还有 0.1 + 0.2 这种价格算出来有很多位小数。帮我把 cart.js 修好，不要改函数名和参数。',
    setup(dir) {
      w(dir, 'cart.js', `// 购物车金额：items = [{ price, qty }]，单位元\nfunction total(items) {\n  let sum = 0;\n  for (const it of items) sum += it.price * it.qty;\n  if (sum > 100) sum -= 20; // 满 100 减 20\n  return sum;\n}\nmodule.exports = { total };\n`);
    },
    check({ dir }) {
      const t = tryRun(() => nodeCjs(dir, `const {total}=require('./cart.js');console.log(JSON.stringify([total([{price:100,qty:1}]),total([{price:0.1,qty:1},{price:0.2,qty:1}]),total([{price:60,qty:2}]),total([{price:99.99,qty:1}])]))`));
      if (t.err) return ok(false, t.err);
      const [a, b, c, d] = JSON.parse(t.out);
      return ok(a === 80 && b === 0.3 && c === 100 && d === 99.99, `100→${a} 0.1+0.2→${b} 120→${c} 99.99→${d}`);
    },
  },
  {
    id: 'fix-async',
    category: '改代码',
    prompt: 'loadAll 应该返回所有用户的名字数组，但现在调用方拿到的是一堆 Promise。帮我修好 users.js。',
    setup(dir) {
      w(dir, 'users.js', `const db = { 1: 'Alice', 2: 'Bob', 3: 'Carol' };\nasync function getUser(id) {\n  await new Promise((r) => setTimeout(r, 5));\n  return { id, name: db[id] };\n}\nasync function loadAll(ids) {\n  const names = [];\n  for (const id of ids) {\n    const u = getUser(id);\n    names.push(u.name || u);\n  }\n  return names;\n}\nmodule.exports = { loadAll, getUser };\n`);
    },
    check({ dir }) {
      const t = tryRun(() => nodeCjs(dir, `require('./users.js').loadAll([1,2,3]).then(r=>console.log(JSON.stringify(r)))`));
      if (t.err) return ok(false, t.err);
      return ok(t.out === '["Alice","Bob","Carol"]', t.out);
    },
  },
  {
    id: 'fix-date',
    category: '改代码',
    prompt: 'formatDate 输出的月份总是少一个月，而且个位数的月和日要补 0（比如 2026-03-05）。修一下 date.js。',
    setup(dir) {
      w(dir, 'date.js', `function formatDate(d) {\n  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();\n}\nmodule.exports = { formatDate };\n`);
    },
    check({ dir }) {
      const t = tryRun(() => nodeCjs(dir, `const {formatDate}=require('./date.js');console.log(formatDate(new Date(2026,2,5))+'|'+formatDate(new Date(2026,11,31)))`));
      if (t.err) return ok(false, t.err);
      return ok(t.out === '2026-03-05|2026-12-31', t.out);
    },
  },
  {
    id: 'fix-python',
    category: '改代码',
    prompt: 'stats.py 里的 median 函数在列表长度是偶数时结果不对，修好它（偶数个时取中间两个数的平均值）。',
    setup(dir) {
      w(dir, 'stats.py', `def mean(xs):\n    return sum(xs) / len(xs)\n\n\ndef median(xs):\n    s = sorted(xs)\n    n = len(s)\n    if n == 0:\n        return None\n    return s[n // 2]\n`);
    },
    check({ dir }) {
      const t = tryRun(() => execFileSync('python3', ['-c', 'import stats;print(stats.median([3,1,2]), stats.median([4,1,3,2]), stats.median([]))'], { cwd: dir, encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] }).trim());
      if (t.err) return ok(false, t.err);
      return ok(/^2 2\.5 None$/.test(t.out), t.out);
    },
  },
  {
    id: 'add-slugify',
    category: '改代码',
    prompt: '在 utils.js 里加一个 slugify(text) 函数并导出：转成小写，去掉首尾空格，连续的空格或下划线变成一个短横线，去掉除字母、数字、短横线以外的字符。例如 "  Hello World__Again! " 变成 "hello-world-again"。',
    setup(dir) {
      w(dir, 'utils.js', `function capitalize(s) {\n  return s.charAt(0).toUpperCase() + s.slice(1);\n}\nmodule.exports = { capitalize };\n`);
    },
    check({ dir }) {
      const t = tryRun(() => nodeCjs(dir, `const u=require('./utils.js');console.log(JSON.stringify([u.slugify('  Hello World__Again! '),u.slugify('A  B'),u.slugify('x_y'),u.capitalize('ab')]))`));
      if (t.err) return ok(false, t.err);
      return ok(t.out === '["hello-world-again","a-b","x-y","Ab"]', t.out);
    },
  },
  {
    id: 'rename-fn',
    category: '改代码',
    prompt: '把项目里所有的 getUserInfo 函数改名为 fetchUserProfile（定义和所有调用的地方都要改），改完要能正常运行。',
    setup(dir) {
      w(dir, 'lib/user.js', `function getUserInfo(id) {\n  return { id, name: 'u' + id };\n}\nmodule.exports = { getUserInfo };\n`);
      w(dir, 'routes/profile.js', `const { getUserInfo } = require('../lib/user');\nmodule.exports = (id) => getUserInfo(id).name;\n`);
      w(dir, 'routes/admin.js', `const user = require('../lib/user');\nmodule.exports = (ids) => ids.map((i) => user.getUserInfo(i).id);\n`);
      w(dir, 'index.js', `const profile = require('./routes/profile');\nconst admin = require('./routes/admin');\nconsole.log(profile(7), admin([1, 2]).join(','));\n`);
    },
    check({ dir }) {
      const all = ['lib/user.js', 'routes/profile.js', 'routes/admin.js', 'index.js'].map((f) => r(dir, f)).join('\n');
      if (/getUserInfo/.test(all)) return ok(false, '还有 getUserInfo');
      const t = tryRun(() => nodeCjs(dir, `require('./index.js')`));
      if (t.err) return ok(false, t.err);
      return ok(t.out === 'u7 1,2' && /fetchUserProfile/.test(r(dir, 'lib/user.js')), t.out);
    },
  },
  {
    id: 'edit-config',
    category: '改代码',
    prompt: '把 config.json 里服务端口改成 8080，再加一个 "debug": true，其他配置保持不变。',
    setup(dir) {
      w(dir, 'config.json', JSON.stringify({ name: 'shop', server: { host: '0.0.0.0', port: 3000 }, db: { url: 'mysql://localhost/shop', pool: 5 } }, null, 2) + '\n');
    },
    check({ dir }) {
      let j;
      try {
        j = JSON.parse(r(dir, 'config.json'));
      } catch (e) {
        return ok(false, 'JSON 坏了');
      }
      return ok(j.server?.port === 8080 && j.debug === true && j.db?.pool === 5 && j.server?.host === '0.0.0.0' && j.name === 'shop', JSON.stringify(j));
    },
  },
  // ---------- 找东西、看懂代码（考搜索） ----------
  {
    id: 'find-constant',
    category: '搜索理解',
    prompt: '这个项目里支付失败后最多重试几次？这个值是在哪个文件里定义的？',
    setup(dir) {
      fakeProject(dir);
      w(dir, 'src/payment/config/limits.js', `// 支付相关的限制\nmodule.exports = {\n  MAX_PAY_RETRY: 4,\n  PAY_TIMEOUT_MS: 15000,\n};\n`);
      w(dir, 'src/order/config/limits.js', `module.exports = { MAX_ORDER_ITEMS: 50 };\n`);
    },
    check({ answer }) {
      return ok(/(^|[^\d])4\s*次|最多.{0,6}4|4\s*times|retry.{0,10}4/i.test(answer) && /payment[\\/]config[\\/]limits\.js|limits\.js/.test(answer), '');
    },
  },
  {
    id: 'find-caller',
    category: '搜索理解',
    prompt: '哪个文件调用了 sendInvoiceEmail？告诉我文件路径和是在哪个函数里调用的。',
    setup(dir) {
      fakeProject(dir);
      w(dir, 'src/notify/mailer.js', `function sendInvoiceEmail(to, invoice) {\n  return { to, id: invoice.id };\n}\nmodule.exports = { sendInvoiceEmail };\n`);
      w(dir, 'src/invoice/service/closeMonth.js', `const { sendInvoiceEmail } = require('../../notify/mailer');\nfunction closeMonthlyBilling(customers) {\n  return customers.map((c) => sendInvoiceEmail(c.email, c.invoice));\n}\nmodule.exports = { closeMonthlyBilling };\n`);
      w(dir, 'src/invoice/service/sendInvoice.md', `# 发票\n这里说明 sendInvoice 的流程（不是代码）。\n`);
    },
    check({ answer }) {
      return ok(/closeMonth\.js/.test(answer) && /closeMonthlyBilling/.test(answer), '');
    },
  },
  {
    id: 'count-todo',
    category: '搜索理解',
    prompt: 'src 文件夹里一共有多少条 TODO 注释？只数 TODO（区分大小写，不算 todo 小写）。',
    setup(dir) {
      fakeProject(dir, 30);
      const spots = ['src/user/a.js', 'src/user/b.js', 'src/order/c.js', 'src/cart/d.js', 'src/cart/d2.js', 'src/report/e.js', 'src/report/f.js'];
      spots.forEach((p, i) => w(dir, p, `// TODO: 第 ${i + 1} 条\nconst x${i} = 1; // todo 小写不算\n${i === 2 ? '// TODO: 同一个文件第二条\n' : ''}`));
      w(dir, 'README.md', 'TODO: 这个不在 src 里\n');
    },
    check({ answer }) {
      return ok(/(^|[^\d])8\s*(条|个|处)?([^\d]|$)/.test(num(answer).replace(/TODO/g, '')) || /共\s*8|8 TODO|eight/i.test(answer), '应为 8');
    },
  },
  {
    id: 'find-file',
    category: '搜索理解',
    prompt: '找到名字里带 PaymentController 的文件，告诉我它相对于这个文件夹的完整路径。',
    setup(dir) {
      fakeProject(dir);
      w(dir, 'modules/billing/web/v2/PaymentController.java', `public class PaymentController {}\n`);
      w(dir, 'modules/billing/web/v1/PaymentControllerTest.md', `旧版说明\n`);
    },
    check({ answer }) {
      return ok(/modules[\\/]billing[\\/]web[\\/]v2[\\/]PaymentController\.java/.test(answer), '');
    },
  },
  {
    id: 'trace-flow',
    category: '搜索理解',
    prompt: '下单接口 POST /api/order 最终把订单数据写到了数据库的哪张表？请顺着代码找一下。',
    setup(dir) {
      fakeProject(dir, 40);
      w(dir, 'server/routes.js', `const orders = require('./handlers/orders');\nmodule.exports = (app) => {\n  app.post('/api/order', orders.create);\n  app.get('/api/order/:id', orders.get);\n};\n`);
      w(dir, 'server/handlers/orders.js', `const svc = require('../services/orderService');\nexports.create = (req, res) => res.json(svc.placeOrder(req.body));\nexports.get = (req, res) => res.json(svc.find(req.params.id));\n`);
      w(dir, 'server/services/orderService.js', `const repo = require('../db/orderRepo');\nexports.placeOrder = (o) => repo.insertOrder({ ...o, status: 'new' });\nexports.find = (id) => repo.byId(id);\n`);
      w(dir, 'server/db/orderRepo.js', `const TABLE = 'shop_orders_v2';\nconst LEGACY = 'orders'; // 旧表，已不再写入\nexports.insertOrder = (o) => ({ sql: \`INSERT INTO \${TABLE} SET ?\`, o });\nexports.byId = (id) => ({ sql: \`SELECT * FROM \${TABLE} WHERE id = ?\`, id });\n`);
    },
    check({ answer }) {
      return ok(/shop_orders_v2/.test(answer), '应为 shop_orders_v2');
    },
  },
  {
    id: 'find-env',
    category: '搜索理解',
    prompt: '这个项目连接的数据库地址是什么？',
    setup(dir) {
      fakeProject(dir, 20);
      w(dir, 'config/.env.production', `APP_NAME=shop\nDATABASE_URL=postgres://shop:secret@db.internal:5432/shop_prod\nREDIS_URL=redis://cache.internal:6379\n`);
      w(dir, 'src/db.js', `const url = process.env.DATABASE_URL;\nmodule.exports = { url };\n`);
    },
    check({ answer }) {
      return ok(/db\.internal:5432\/shop_prod/.test(answer), '');
    },
  },
  // ---------- 大项目里的搜索（匹配很多、要忽略大小写、文件藏得深） ----------
  {
    id: 'big-refund',
    category: '搜索理解',
    prompt: '项目里很多地方调用了 refundOrder，但只有一处调用时传了 force: true（强制退款）。是哪个文件、哪个函数？',
    setup(dir) {
      fakeProject(dir, 300);
      for (let i = 0; i < 160; i++) w(dir, `src/refund/caller${i}.js`, `const { refundOrder } = require('../core/refund');\nfunction handle${i}(o) {\n  return refundOrder(o.id, { force: false, reason: 'r${i}' });\n}\nmodule.exports = { handle${i} };\n`);
      w(dir, 'src/admin/tools/manualOps.js', `const { refundOrder } = require('../../core/refund');\nfunction forceRefundByAdmin(order) {\n  // 管理员强制退款\n  return refundOrder(order.id, {\n    force: true,\n    reason: 'admin',\n  });\n}\nmodule.exports = { forceRefundByAdmin };\n`);
      w(dir, 'src/core/refund.js', `function refundOrder(id, opts) {\n  return { id, ...opts };\n}\nmodule.exports = { refundOrder };\n`);
    },
    check({ answer }) {
      return ok(/manualOps\.js/.test(answer) && /forceRefundByAdmin/.test(answer), '');
    },
  },
  {
    id: 'count-legacy',
    category: '搜索理解',
    prompt: '项目里一共有多少个文件用到了 legacyAuth？不区分大小写（legacyAuth、LegacyAuth、legacyauth、LEGACYAUTH 都算），但带下划线的 LEGACY_AUTH 不算。',
    setup(dir) {
      fakeProject(dir, 300);
      const forms = ['legacyAuth', 'LegacyAuth', 'legacyauth', 'LEGACYAUTH'];
      for (let i = 0; i < 23; i++) w(dir, `src/mod${i % 7}/feature${i}/index.js`, `// uses ${forms[i % 4]}\n${Array.from({ length: 6 }, (_, k) => `const v${k} = ${forms[(i + k) % 4]}.check(${k});`).join('\n')}\n`);
      for (let i = 0; i < 9; i++) w(dir, `src/other/cfg${i}.js`, `const LEGACY_AUTH = false; // 不算\n`);
    },
    check({ answer }) {
      return ok(/(^|[^\d])23\s*(个|份)?\s*(文件|files?)/.test(num(answer)) || /共\s*23|23\s*个/.test(num(answer)), '应为 23 个文件');
    },
  },
  {
    id: 'deep-file',
    category: '搜索理解',
    prompt: '退款规则配置文件 refund_policy 在哪里？把它里面「超过多少天不能退款」的天数告诉我。',
    setup(dir) {
      fakeProject(dir, 400);
      for (let i = 0; i < 40; i++) w(dir, `deploy/env${i % 5}/services/svc${i}/conf/app.yaml`, `name: svc${i}\nreplicas: ${i % 3 + 1}\n`);
      w(dir, 'deploy/env3/services/svc27/conf/policies/refund_policy.yaml', `refund:\n  max_days: 17\n  require_receipt: true\n`);
      w(dir, 'docs/refund_policy_draft.md', `草稿：最多 30 天（未生效）\n`);
    },
    check({ answer }) {
      return ok(/(^|[^\d])17\s*天/.test(num(answer)) && /refund_policy\.yaml/.test(answer), '应为 17 天');
    },
  },
  // ---------- 处理数据和文件 ----------
  {
    id: 'csv-sum',
    category: '数据文件',
    prompt: 'sales.csv 里 2026 年 10 月的销售额（单价 × 数量）一共是多少元？',
    setup(dir) {
      const rows = ['date,product,price,qty'];
      let total = 0;
      for (let i = 0; i < 40; i++) {
        const m = i % 3 === 0 ? '09' : i % 3 === 1 ? '10' : '11';
        const price = 10 + (i % 7) * 5;
        const qty = 1 + (i % 4);
        if (m === '10') total += price * qty;
        rows.push(`2026-${m}-${String((i % 28) + 1).padStart(2, '0')},P${i % 9},${price},${qty}`);
      }
      w(dir, 'sales.csv', rows.join('\n') + '\n');
      fs.writeFileSync(path.join(dir, '.answer'), String(total));
    },
    check({ dir, answer }) {
      const want = fs.readFileSync(path.join(dir, '.answer'), 'utf8');
      return ok(new RegExp(`(^|[^\\d])${want}(\\.0+)?([^\\d]|$)`).test(num(answer)), `应为 ${want}`);
    },
  },
  {
    id: 'json-to-csv',
    category: '数据文件',
    prompt: '把 users.json 转成 users.csv，表头是 id,name,city（city 取 address.city），按 id 从小到大排列，不要多余的列。',
    setup(dir) {
      const users = [
        { id: 3, name: '王五', address: { city: '上海', zip: '200000' }, age: 30 },
        { id: 1, name: '张三', address: { city: '北京', zip: '100000' }, age: 25 },
        { id: 2, name: '李四', address: { city: '苏州', zip: '215000' }, age: 28 },
      ];
      w(dir, 'users.json', JSON.stringify(users, null, 2));
    },
    check({ dir }) {
      if (!exists(dir, 'users.csv')) return ok(false, '没有 users.csv');
      const lines = r(dir, 'users.csv').replace(/^﻿/, '').trim().split(/\r?\n/).map((l) => l.replace(/"/g, '').trim());
      return ok(lines.join('|') === 'id,name,city|1,张三,北京|2,李四,苏州|3,王五,上海', lines.join('|'));
    },
  },
  {
    id: 'organize',
    category: '数据文件',
    prompt: '把这个文件夹里的图片（png、jpg）移到 images 文件夹，文档（pdf、docx、txt）移到 docs 文件夹，其他文件不要动。',
    setup(dir) {
      for (const f of ['a.png', 'b.jpg', 'c.PNG', 'report.pdf', 'notes.txt', 'plan.docx', 'run.sh', 'data.csv']) w(dir, f, 'x');
    },
    check({ dir }) {
      const want = { 'images/a.png': 1, 'images/b.jpg': 1, 'images/c.PNG': 1, 'docs/report.pdf': 1, 'docs/notes.txt': 1, 'docs/plan.docx': 1, 'run.sh': 1, 'data.csv': 1 };
      const miss = Object.keys(want).filter((f) => !exists(dir, f));
      return ok(!miss.length, miss.length ? '缺 ' + miss.join(',') : '');
    },
  },
  {
    id: 'log-errors',
    category: '数据文件',
    prompt: 'app.log 里一共有多少行 ERROR？出现次数最多的错误信息是什么？',
    setup(dir) {
      const lines = [];
      const errs = ['Connection refused: redis', 'Timeout calling payment gateway', 'Connection refused: redis', 'NullPointerException in OrderService', 'Connection refused: redis', 'Timeout calling payment gateway'];
      for (let i = 0; i < 120; i++) {
        if (i % 9 === 4) lines.push(`2026-11-20 10:${String(i % 60).padStart(2, '0')}:00 ERROR ${errs[((i / 9) | 0) % errs.length]}`);
        else lines.push(`2026-11-20 10:${String(i % 60).padStart(2, '0')}:00 INFO request ok id=${i}`);
      }
      w(dir, 'app.log', lines.join('\n') + '\n');
      const er = lines.filter((l) => / ERROR /.test(l));
      const cnt = {};
      er.forEach((l) => (cnt[l.split(' ERROR ')[1]] = (cnt[l.split(' ERROR ')[1]] || 0) + 1));
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
      fs.writeFileSync(path.join(dir, '.answer'), JSON.stringify({ n: er.length, top }));
    },
    check({ dir, answer }) {
      const { n, top } = JSON.parse(fs.readFileSync(path.join(dir, '.answer'), 'utf8'));
      const hasN = new RegExp(`(^|[^\\d])${n}\\s*(行|条|次|lines?)`).test(num(answer)) || new RegExp(`共\\s*${n}|${n}\\s*行`).test(num(answer));
      return ok(hasN && answer.toLowerCase().includes(top.toLowerCase().slice(0, 18)), `应为 ${n} 行，最多：${top}`);
    },
  },
  // ---------- 纯聊天 ----------
  {
    id: 'qa-math',
    category: '问答',
    folder: false,
    prompt: '一个数加上它的 20% 等于 90，这个数是多少？只给出结果和一句话过程。',
    check({ answer }) {
      return ok(/(^|[^\d])75([^\d]|$)/.test(num(answer)), '应为 75');
    },
  },
  {
    id: 'qa-weekday',
    category: '问答',
    folder: false,
    prompt: '2026 年 11 月 23 日是星期几？',
    check({ answer }) {
      return ok(/星期一|周一|礼拜一|Monday/i.test(answer) && !/星期[二三四五六日天]是/.test(answer), '应为星期一');
    },
  },
  {
    id: 'qa-primes',
    category: '问答',
    folder: false,
    prompt: '列出 1 到 50 之间个位数是 3 的质数。',
    check({ answer }) {
      // 结论里按顺序列出 3、13、23、43，中间没有夹着 33（推导里提到 33 是合数不算错）
      const plain = answer.replace(/\*\*/g, '');
      return ok(/(^|[^\d])3[^\d]{1,6}13[^\d]{1,6}23[^\d]{1,6}43([^\d]|$)/.test(plain), '没有找到正确的结论');
    },
  },
];
