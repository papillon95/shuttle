// 定时任务的时间计算测试：node scripts/test-scheduler.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../src/scheduler.js');

let failed = 0;
const d = (y, m, day, h = 0, min = 0) => new Date(y, m - 1, day, h, min, 0, 0);
function eq(name, got, want) {
  const g = got instanceof Date ? S.fmt(got) : JSON.stringify(got);
  const w = want instanceof Date ? S.fmt(want) : JSON.stringify(want);
  if (g === w) console.log('ok -', name);
  else {
    failed++;
    console.error(`✗ ${name}\n  期望 ${w}\n  实际 ${g}`);
  }
}
function throws(name, fn, part) {
  try {
    fn();
    failed++;
    console.error(`✗ ${name}：应该报错`);
  } catch (e) {
    if (part && !e.message.includes(part)) {
      failed++;
      console.error(`✗ ${name}：错误信息不对 ${e.message}`);
    } else console.log('ok -', name);
  }
}

// 每天
const daily = S.normalizeRule({ type: 'daily', time: '9:00' });
eq('每天：时间补零', daily, { type: 'daily', time: '09:00' });
eq('每天：当天还没到', S.nextRun(daily, d(2026, 11, 17, 8, 0)), d(2026, 11, 17, 9, 0));
eq('每天：当天已过取明天', S.nextRun(daily, d(2026, 11, 17, 9, 0)), d(2026, 11, 18, 9, 0));
eq('每天：跨月', S.nextRun(daily, d(2026, 11, 30, 10, 0)), d(2026, 12, 1, 9, 0));
eq('每天：跨年', S.nextRun(daily, d(2026, 12, 31, 23, 0)), d(2027, 1, 1, 9, 0));

// 每周（2026-11-17 是周二）
const weekly = S.normalizeRule({ type: 'weekly', weekdays: [5, 1, 1], time: '18:30' });
eq('每周：去重排序', weekly.weekdays, [1, 5]);
eq('每周：本周五', S.nextRun(weekly, d(2026, 11, 17, 12)), d(2026, 11, 20, 18, 30));
eq('每周：周五过了取下周一', S.nextRun(weekly, d(2026, 11, 20, 19)), d(2026, 11, 23, 18, 30));
eq('每周：周日', S.nextRun(S.normalizeRule({ type: 'weekly', weekdays: [7], time: '08:00' }), d(2026, 11, 17)), d(2026, 11, 22, 8, 0));
throws('每周：没选日期', () => S.normalizeRule({ type: 'weekly', weekdays: [], time: '09:00' }), '至少');

// 每月
const m31 = S.normalizeRule({ type: 'monthly', day: 31, time: '10:00' });
eq('每月 31 日：11 月取 30 日', S.nextRun(m31, d(2026, 11, 17)), d(2026, 11, 30, 10, 0));
eq('每月 31 日：12 月 31 日', S.nextRun(m31, d(2026, 11, 30, 11)), d(2026, 12, 31, 10, 0));
const m29 = S.normalizeRule({ type: 'monthly', day: 29, time: '10:00' });
eq('每月 29 日：平年 2 月取 28 日', S.nextRun(m29, d(2027, 2, 1)), d(2027, 2, 28, 10, 0));
eq('每月 29 日：闰年 2 月 29 日', S.nextRun(m29, d(2028, 2, 1)), d(2028, 2, 29, 10, 0));
eq('每月 1 日：当天已过取下月', S.nextRun(S.normalizeRule({ type: 'monthly', day: 1, time: '09:00' }), d(2026, 12, 1, 9, 30)), d(2027, 1, 1, 9, 0));
throws('每月：日期越界', () => S.normalizeRule({ type: 'monthly', day: 32, time: '09:00' }), '1 到 31');

// 间隔
const iv = S.normalizeRule({ type: 'interval', minutes: '30' });
eq('间隔 30 分钟', S.nextRun(iv, d(2026, 11, 17, 9, 0)), d(2026, 11, 17, 9, 30));
throws('间隔太短', () => S.normalizeRule({ type: 'interval', minutes: 5 }), '至少 15');

// 一次性
const once = S.normalizeRule({ type: 'once', at: '2026-11-20 09:05' });
eq('一次：格式规范化', once.at, '2026-11-20T09:05');
eq('一次：还没到', S.nextRun(once, d(2026, 11, 17)), d(2026, 11, 20, 9, 5));
eq('一次：已过返回 null', S.nextRun(once, d(2026, 11, 21)), null);
throws('时间格式错', () => S.normalizeRule({ type: 'daily', time: '25:00' }), 'HH:MM');
throws('未知类型', () => S.normalizeRule({ type: 'yearly' }), '不支持');

// 到期判断：从上次运行时间算起，错过多次只补一次
const sched = { id: 'a', enabled: true, rule: daily, createdAt: d(2026, 11, 10, 12).toISOString() };
eq('到期：创建后第二天 9 点到期', S.checkDue(sched, d(2026, 11, 11, 9, 0, 30)).due, true);
eq('到期：还没到', S.checkDue(sched, d(2026, 11, 11, 8, 59)).due, false);
const late = S.checkDue(sched, d(2026, 11, 17, 14, 0)); // 关机一周
eq('错过多次：到期且标记补跑', [late.due, late.missed], [true, true]);
eq('错过多次：补跑的原定时间是最早错过的那次', late.scheduledAt, d(2026, 11, 11, 9, 0));
const ran = S.afterRun(sched, 'ok', 'conv1', d(2026, 11, 17, 14, 1));
eq('补跑后不再连续补', S.checkDue(ran, d(2026, 11, 17, 20, 0)).due, false);
eq('补跑后下次按时', S.checkDue(ran, d(2026, 11, 18, 9, 0)).due, true);
eq('停用的不到期', S.checkDue({ ...sched, enabled: false }, d(2026, 11, 17, 14)).due, false);
const onceSched = { id: 'b', enabled: true, rule: once, createdAt: d(2026, 11, 17).toISOString() };
eq('一次性到期', S.checkDue(onceSched, d(2026, 11, 20, 9, 6)).due, true);
const onceRan = S.afterRun(onceSched, 'ok', 'c', d(2026, 11, 20, 9, 6));
eq('一次性运行后停用', [onceRan.enabled, onceRan.lastStatus, onceRan.lastConvId], [false, 'ok', 'c']);

// 说明文字
eq('说明：工作日', S.describe(S.normalizeRule({ type: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00' })), '每个工作日 09:00');
eq('说明：每周一、三', S.describe(S.normalizeRule({ type: 'weekly', weekdays: [3, 1], time: '09:00' })), '每周一、三 09:00');
eq('说明：每 2 小时', S.describe(S.normalizeRule({ type: 'interval', minutes: 120 })), '每 2 小时');
eq('说明：英文', S.describe(daily, 'en'), 'Every day at 09:00');

if (failed) {
  console.error(`\n${failed} 项失败`);
  process.exit(1);
}
console.log('\n全部通过');
