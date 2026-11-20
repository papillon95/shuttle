// 自绘下拉框：替换系统原生的 <select> 弹出列表（Windows 上原生的又大又丑，和界面风格不搭）。
// <select> 本身保留（隐藏），取值、onchange、optgroup 都照旧，所以原来读写 sel.value 的代码不用改。
'use strict';
(() => {
  const CHEVRON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
  const CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>';
  let openPop = null; // 当前打开的 {pop, close}

  function closeOpen() {
    openPop?.close();
  }
  document.addEventListener('mousedown', (e) => {
    if (openPop && !openPop.pop.contains(e.target) && !openPop.btn.contains(e.target)) closeOpen();
  });
  window.addEventListener('blur', closeOpen);
  window.addEventListener('resize', closeOpen);
  // 外面滚动（比如设置页往下滚）时关掉，弹层自己里面滚不算
  document.addEventListener('scroll', (e) => {
    if (openPop && !openPop.pop.contains(e.target)) closeOpen();
  }, true);

  /**
   * opts.up：优先向上弹出（输入框里的下拉）
   * opts.className：按钮额外的 class
   */
  window.enhanceSelect = function enhanceSelect(sel, opts = {}) {
    if (!sel || sel._picker) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-btn ' + (opts.className || '');
    btn.innerHTML = '<span class="pick-text"></span>' + CHEVRON;
    sel.after(btn);
    sel.classList.add('pick-native');
    sel.tabIndex = -1;

    const sync = () => {
      const o = sel.options[sel.selectedIndex];
      btn.querySelector('.pick-text').textContent = o ? o.textContent : '';
      btn.title = sel.title || '';
      btn.disabled = sel.disabled;
    };
    // 代码里直接改 sel.value / selectedIndex 不会触发事件：拦一下，顺便刷新按钮上的文字
    for (const prop of ['value', 'selectedIndex']) {
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
      Object.defineProperty(sel, prop, {
        configurable: true,
        get() {
          return d.get.call(this);
        },
        set(v) {
          d.set.call(this, v);
          sync();
        },
      });
    }
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['title', 'disabled', 'label'] });
    sel.addEventListener('change', sync);

    function open() {
      if (openPop?.btn === btn) return closeOpen();
      closeOpen();
      const pop = document.createElement('div');
      pop.className = 'pick-pop';
      pop.setAttribute('role', 'listbox');
      const items = [];
      const addOption = (o) => {
        const it = document.createElement('div');
        it.className = 'pick-item' + (o.disabled ? ' disabled' : '') + (o.selected ? ' on' : '');
        it.setAttribute('role', 'option');
        it.innerHTML = `<span class="pick-label"></span><span class="pick-check">${o.selected ? CHECK : ''}</span>`;
        it.querySelector('.pick-label').textContent = o.textContent;
        if (o.style.fontFamily) it.querySelector('.pick-label').style.fontFamily = o.style.fontFamily; // 字体选择：每项用自己的字体显示
        if (o.title) it.title = o.title;
        it.onclick = () => choose(o);
        it.onmousemove = () => focusItem(items.indexOf(it));
        it._opt = o;
        pop.appendChild(it);
        items.push(it);
      };
      for (const c of sel.children) {
        if (c.tagName === 'OPTGROUP') {
          const g = document.createElement('div');
          g.className = 'pick-group';
          g.textContent = c.label;
          pop.appendChild(g);
          for (const o of c.children) if (!o.hidden) addOption(o);
        } else if (c.tagName === 'OPTION' && !c.hidden) addOption(c);
      }
      document.body.appendChild(pop);

      // 位置：按钮下方（放不下就上方），右边超出窗口就右对齐
      const r = btn.getBoundingClientRect();
      const w = Math.max(r.width, pop.offsetWidth);
      pop.style.minWidth = r.width + 'px';
      const left = Math.min(r.left, window.innerWidth - w - 8);
      pop.style.left = Math.max(8, left) + 'px';
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const up = opts.up ? above > 160 || above > below : below < 220 && above > below;
      pop.style.maxHeight = Math.min(420, up ? above : below) + 'px';
      if (up) pop.style.bottom = window.innerHeight - r.top + 6 + 'px';
      else pop.style.top = r.bottom + 6 + 'px';
      pop.classList.add(up ? 'up' : 'down');

      let cur = items.findIndex((x) => x.classList.contains('on'));
      function focusItem(i) {
        items[cur]?.classList.remove('kb');
        cur = i;
        items[cur]?.classList.add('kb');
      }
      focusItem(cur);
      items[cur]?.scrollIntoView({ block: 'nearest' });
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
          btn.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const step = e.key === 'ArrowDown' ? 1 : -1;
          let i = cur;
          for (let n = 0; n < items.length; n++) {
            i = (i + step + items.length) % items.length;
            if (!items[i]._opt.disabled) break;
          }
          focusItem(i);
          items[i]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && items[cur]) {
          e.preventDefault();
          choose(items[cur]._opt);
        }
      };
      document.addEventListener('keydown', onKey, true);
      function close() {
        pop.remove();
        document.removeEventListener('keydown', onKey, true);
        btn.classList.remove('open');
        if (openPop?.pop === pop) openPop = null;
      }
      function choose(o) {
        if (o.disabled) return;
        close();
        if (sel.value === o.value) return;
        sel.value = o.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      btn.classList.add('open');
      openPop = { pop, btn, close };
    }
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    btn.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !openPop) {
        e.preventDefault();
        open();
      }
    });
    sel._picker = { btn, sync };
    sync();
  };
})();
