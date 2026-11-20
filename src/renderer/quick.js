// 快捷小窗界面：输入问题 → 流式显示回答；可带上最近复制的文字作为引用
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let LANG = 'zh';
const T = (k, vars) => window.I18N.t(LANG, k, vars);
let quote = '';
let answer = '';
let streaming = false;
let queued = false;

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = T(el.dataset.i18n)));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = T(el.dataset.i18nTitle)));
}
// 窗口高度跟着内容走
function fit() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    window.quick.resize($('qa').getBoundingClientRect().height + 16);
  });
}
function setQuote(t) {
  quote = t || '';
  $('qaQuote').classList.toggle('hidden', !quote);
  $('qaQuoteText').textContent = quote.length > 300 ? quote.slice(0, 300) + '…' : quote;
  $('qaInput').placeholder = T(quote ? 'quickPhQuote' : 'quickPh');
  fit();
}
function reset() {
  answer = '';
  streaming = false;
  $('qaAnswer').classList.add('hidden');
  $('qaAnswer').innerHTML = '';
  $('qaFoot').classList.add('hidden');
  $('qaInput').value = '';
}
window.quick.onOpen(async () => {
  const s = await window.quick.state();
  LANG = s.lang === 'en' ? 'en' : 'zh';
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
  applyI18n();
  reset();
  $('qaModel').textContent = s.model || '';
  setQuote(s.quote);
  if (!s.loggedIn) {
    $('qaAnswer').classList.remove('hidden');
    $('qaAnswer').textContent = T('quickNeedLogin');
  }
  $('qaInput').focus();
  fit();
});
// 输入了内容就不因为点到别处而关闭
$('qaInput').addEventListener('input', () => window.quick.sticky(!!$('qaInput').value.trim()));
$('qaQuoteX').onclick = () => {
  setQuote('');
  $('qaInput').focus();
};
$('qaForm').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('qaInput').value.trim();
  if (!q && !quote) return;
  if (streaming) return;
  answer = '';
  streaming = true;
  $('qaAnswer').classList.remove('hidden');
  $('qaAnswer').innerHTML = `<span class="cursor"></span>`;
  $('qaFoot').classList.add('hidden');
  fit();
  window.quick.ask(q, quote);
};
window.quick.onDelta((d) => {
  answer += d;
  $('qaAnswer').innerHTML = md(answer) + '<span class="cursor"></span>';
  $('qaAnswer').scrollTop = $('qaAnswer').scrollHeight;
  fit();
});
window.quick.onDone((r) => {
  streaming = false;
  if (!r.ok) {
    if (r.error) $('qaAnswer').innerHTML = `<div class="qa-err">${esc(r.error)}</div>`;
    else if (!answer) $('qaAnswer').classList.add('hidden');
  } else $('qaAnswer').innerHTML = md(answer);
  $('qaFoot').classList.toggle('hidden', !answer);
  fit();
});
$('qaCopy').onclick = () => {
  window.quick.copy();
  $('qaCopy').textContent = T('copied');
  setTimeout(() => ($('qaCopy').textContent = T('copy')), 1200);
};
$('qaMain').onclick = async () => {
  const r = await window.quick.continueInMain();
  if (!r.ok && r.error) {
    $('qaFoot').querySelector('.qa-model').textContent = r.error;
  }
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (streaming) window.quick.stop();
    window.quick.hide();
  }
});
// 回答里的链接用系统浏览器打开；代码块复制
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-href]');
  if (a) {
    e.preventDefault();
    if (/^https?:\/\//i.test(a.dataset.href)) window.quick.openExternal(a.dataset.href);
  }
  const c = e.target.closest('.code-copy');
  if (c) navigator.clipboard.writeText(c.closest('.code').querySelector('code').textContent);
});
