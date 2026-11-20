// 定时任务：计算下次运行时间、判断是否到期、生成说明文字。
// 这里全是纯函数（不碰 Electron、不读写文件），方便单测；真正的定时运行在 main.js 里。
//
// rule 的格式：
//   { type: 'daily',    time: '09:00' }
//   { type: 'weekly',   weekdays: [1, 3, 5], time: '09:00' }   1=周一 … 7=周日
//   { type: 'monthly',  day: 1-31, time: '09:00' }             当月没有这天就取最后一天
//   { type: 'interval', minutes: 15+ }
//   { type: 'once',     at: '2026-11-20T09:00' }                运行后自动停用
// 时间都按本机时区。

const MIN_INTERVAL = 15;

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, min } : null;
}
function parseLocal(s) {
  // '2026-11-20T09:00' 按本机时区解析（new Date 对不带时区的日期时间字符串在各环境行为一致：本地时间）
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
}
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
// JS 的 getDay()：0=周日；我们用 1=周一 … 7=周日
const isoWeekday = (d) => d.getDay() || 7;

/** 校验并规范化 rule；不合法时抛出带中文说明的错误 */
function normalizeRule(rule) {
  if (!rule || typeof rule !== 'object') throw new Error('缺少运行周期');
  const type = rule.type;
  if (type === 'daily' || type === 'weekly' || type === 'monthly') {
    const t = parseTime(rule.time);
    if (!t) throw new Error('时间格式应为 HH:MM，比如 09:00');
    const time = `${String(t.h).padStart(2, '0')}:${String(t.min).padStart(2, '0')}`;
    if (type === 'daily') return { type, time };
    if (type === 'weekly') {
      const weekdays = [...new Set((rule.weekdays || []).map(Number))].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
      if (!weekdays.length) throw new Error('每周运行至少要选一天');
      return { type, weekdays, time };
    }
    const day = Number(rule.day);
    if (!(day >= 1 && day <= 31)) throw new Error('每月的日期应在 1 到 31 之间');
    return { type, day: Math.floor(day), time };
  }
  if (type === 'interval') {
    const minutes = Math.floor(Number(rule.minutes));
    if (!(minutes >= MIN_INTERVAL)) throw new Error(`间隔至少 ${MIN_INTERVAL} 分钟`);
    return { type, minutes };
  }
  if (type === 'once') {
    const d = parseLocal(rule.at);
    if (!d) throw new Error('运行时间格式应为 2026-11-20T09:00');
    const p = (n) => String(n).padStart(2, '0');
    return { type, at: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` };
  }
  throw new Error('不支持的周期类型：' + type);
}

/** from 之后（不含 from 本身）的下一次运行时间；没有下一次（一次性任务已过）返回 null */
function nextRun(rule, from) {
  const base = new Date(from);
  if (rule.type === 'interval') return new Date(base.getTime() + rule.minutes * 60000);
  if (rule.type === 'once') {
    const at = parseLocal(rule.at);
    return at && at > base ? at : null;
  }
  const t = parseTime(rule.time);
  if (!t) return null;
  // 从 from 当天开始往后逐天找第一个符合条件、且晚于 from 的时刻（最多找 400 天，覆盖每月 31 日的情况）
  for (let i = 0; i <= 400; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, t.h, t.min, 0, 0);
    if (d <= base) continue;
    if (rule.type === 'daily') return d;
    if (rule.type === 'weekly' && rule.weekdays.includes(isoWeekday(d))) return d;
    if (rule.type === 'monthly') {
      const want = Math.min(rule.day, daysInMonth(d.getFullYear(), d.getMonth()));
      if (d.getDate() === want) return d;
    }
  }
  return null;
}

/**
 * 是否到期。下一次运行时间从「上次运行时间」（没运行过就是创建时间）算起，
 * 所以 Shuttle 关着期间错过了好几次，打开后也只补跑一次。
 * 返回 { due, scheduledAt, missed }；missed 表示比原定时间晚了 5 分钟以上（补跑）。
 */
function checkDue(schedule, now = new Date()) {
  if (!schedule || schedule.enabled === false) return { due: false };
  const from = new Date(schedule.lastRunAt || schedule.createdAt || 0);
  const at = nextRun(schedule.rule, from);
  if (!at || at > now) return { due: false, nextAt: at };
  return { due: true, scheduledAt: at, missed: now - at > 5 * 60000 };
}

/** 运行之后要更新的字段 */
function afterRun(schedule, status, convId, now = new Date()) {
  return {
    ...schedule,
    lastRunAt: now.toISOString(),
    lastStatus: status,
    lastConvId: convId || schedule.lastConvId || null,
    enabled: schedule.rule.type === 'once' ? false : schedule.enabled,
  };
}

const WEEK = { zh: ['', '一', '二', '三', '四', '五', '六', '日'], en: ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] };
/** 周期的说明文字，比如「每天 09:00」「每周一、三 09:00」 */
function describe(rule, lang = 'zh') {
  const en = lang === 'en';
  switch (rule.type) {
    case 'daily':
      return en ? `Every day at ${rule.time}` : `每天 ${rule.time}`;
    case 'weekly': {
      const all = rule.weekdays.length === 7;
      const workdays = rule.weekdays.join() === '1,2,3,4,5';
      if (en) return `${all ? 'Every day' : workdays ? 'Weekdays' : 'Every ' + rule.weekdays.map((d) => WEEK.en[d]).join(', ')} at ${rule.time}`;
      return `${all ? '每天' : workdays ? '每个工作日' : '每周' + rule.weekdays.map((d) => WEEK.zh[d]).join('、')} ${rule.time}`;
    }
    case 'monthly':
      return en ? `Monthly on day ${rule.day} at ${rule.time}` : `每月 ${rule.day} 日 ${rule.time}${rule.day > 28 ? '（没有这天的月份取最后一天）' : ''}`;
    case 'interval': {
      const h = rule.minutes % 60 === 0 ? rule.minutes / 60 : 0;
      if (en) return h ? `Every ${h} hour${h > 1 ? 's' : ''}` : `Every ${rule.minutes} minutes`;
      return h ? `每 ${h} 小时` : `每 ${rule.minutes} 分钟`;
    }
    case 'once':
      return en ? `Once at ${rule.at.replace('T', ' ')}` : `${rule.at.replace('T', ' ')} 运行一次`;
    default:
      return '';
  }
}

/** 本地时间格式化成 2026-11-20 09:00 */
function fmt(d) {
  if (!d) return '';
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

module.exports = { MIN_INTERVAL, normalizeRule, nextRun, checkDue, afterRun, describe, fmt, parseLocal };
