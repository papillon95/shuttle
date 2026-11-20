// 截图框选：整屏截图做背景，拖动选出一块区域；松开鼠标确认，Esc 或右键取消
const $ = (id) => document.getElementById(id);
const zh = !/^en/i.test(navigator.language || '');
$('tip').textContent = zh ? '拖动鼠标框选要截取的区域，松开完成；Esc 取消' : 'Drag to select an area, release to capture; Esc to cancel';
let start = null;
let imgUrl = '';
window.capture.onImage((url) => {
  imgUrl = url;
  $('bg').src = url;
});
function draw(x, y) {
  const left = Math.min(start.x, x);
  const top = Math.min(start.y, y);
  const w = Math.abs(x - start.x);
  const h = Math.abs(y - start.y);
  const s = $('sel');
  s.style.display = 'block';
  s.style.left = left + 'px';
  s.style.top = top + 'px';
  s.style.width = w + 'px';
  s.style.height = h + 'px';
  // 选区里显示原图（不变暗）
  s.style.backgroundImage = `url("${imgUrl}")`;
  s.style.backgroundSize = `${innerWidth}px ${innerHeight}px`;
  s.style.backgroundPosition = `${-left}px ${-top}px`;
  const z = $('size');
  z.style.display = 'block';
  z.textContent = `${Math.round(w * devicePixelRatio)} × ${Math.round(h * devicePixelRatio)}`;
  z.style.left = left + 'px';
  z.style.top = Math.max(0, top - 24) + 'px';
}
addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  start = { x: e.clientX, y: e.clientY };
  $('mask').style.display = 'none';
  $('tip').style.display = 'none';
});
addEventListener('mousemove', (e) => start && draw(e.clientX, e.clientY));
addEventListener('mouseup', (e) => {
  if (!start || e.button !== 0) return;
  const sel = { x: start.x, y: start.y, width: e.clientX - start.x, height: e.clientY - start.y };
  start = null;
  if (Math.abs(sel.width) < 4 || Math.abs(sel.height) < 4) {
    // 只是点了一下：恢复提示，继续等用户框选
    $('sel').style.display = 'none';
    $('size').style.display = 'none';
    $('mask').style.display = 'block';
    $('tip').style.display = 'block';
    return;
  }
  window.capture.done(sel);
});
addEventListener('keydown', (e) => e.key === 'Escape' && window.capture.cancel());
addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.capture.cancel();
});
