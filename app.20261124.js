/* 绘本网页版电子书 · 逻辑
   StPageFlip 2.0.7 HTML 模式，单实例 usePortrait 自动切换 PC 双页 / 手机单页。
   关键约束：
   - 页内零 id（portrait 翻页会 cloneNode(true)）
   - 懒加载状态用全局 Map 管，不依赖 DOM dataset（克隆页是快照）
   - changeOrientation 里绝不 destroy / turnToPage，库已内置页码补偿
   - 页根 .stf__item 的 cssText 每帧被覆写，样式全在 .page-inner 上
*/
(function () {
  'use strict';

  var BREAK = 720;                 // 与 options.minWidth*2 对齐
  var manifest = null;
  var toc = null;                  // 两级目录数据（assets/toc.v1.json）
  var tocBuilt = false;
  var flip = null;
  var state = new Map();           // index -> { hi, lo, lqip, decoded, pending }
  var useHi = true;
  var lastOrientation = null;
  var resizeTimer = null;
  var updateTimer = null;
  var els = {};

  function $(id) { return document.getElementById(id); }

  function loadManifest() {
    return fetch('./assets/manifest.v1.json', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('manifest HTTP ' + r.status);
      return r.json();
    });
  }

  function pageLabel(i) {
    var p = manifest.pages[i];
    if (!p) return '';
    if (p.cover) return '封面';
    if (p.back) return '封底';
    if (p.blank) return '空白页';
    return 'P' + p.num;
  }

  function findSpread(idx, spreads) {
    for (var i = 0; i < spreads.length; i++) {
      if (spreads[i].indexOf(idx) >= 0) return spreads[i];
    }
    return [idx];
  }

  /* ---------- 构建页 DOM ---------- */
  function buildPages() {
    var book = $('book');
    var frag = document.createDocumentFragment();
    manifest.pages.forEach(function (p) {
      var page = document.createElement('div');
      page.className = 'page';
      page.setAttribute('data-page', String(p.index));
      if (p.cover) page.setAttribute('data-cover', '1');
      if (p.back) page.setAttribute('data-back', '1');
      // setDensity() 不改 classList，封面/封底必须显式声明 hard
      if (p.cover || p.back) page.setAttribute('data-density', 'hard');

      var inner = document.createElement('div');
      inner.className = 'page-inner';
      inner.style.backgroundImage = 'url("' + p.lqip + '")';

      var img = document.createElement('img');
      img.className = 'page-img';
      img.alt = p.cover ? '封面' : (p.back ? '封底' : (p.blank ? '空白页' : '第 ' + p.num + ' 页'));
      img.decoding = 'async';
      img.draggable = false;
      // 确定的字符串：cloneNode 复制后仍是它，克隆页不会变成空白
      img.src = p.lqip;
      inner.appendChild(img);

      // 中缝书脊阴影元素已取消：两页并排时不做任何静态阴影叠加
      // 页内不叠页码：本页是满版设计，页码由工具栏的「P4 – P5 · 5/88」承担
      page.appendChild(inner);
      frag.appendChild(page);
      state.set(p.index, { hi: p.hi, lo: p.lo, lqip: p.lqip, decoded: false, pending: null });
    });
    book.appendChild(frag);
    return book.querySelectorAll('.page');
  }

  /* ---------- 懒加载：LQIP -> 真实图，先 decode 再翻页 ---------- */
  function ensure(index) {
    var s = state.get(index);
    if (!s || s.decoded) return Promise.resolve();
    if (s.pending) return s.pending;

    var url = useHi ? s.hi : s.lo;
    var im = new Image();
    s.pending = new Promise(function (resolve) {
      function finish() {
        // 同时更新原页与可能存在的克隆页
        var nodes = document.querySelectorAll(
          '.page[data-page="' + index + '"] > .page-inner > .page-img');
        for (var k = 0; k < nodes.length; k++) {
          nodes[k].src = url;
          nodes[k].classList.add('is-loaded');
        }
        s.decoded = true;
        resolve();
        // 淡入结束后撤掉 LQIP 底图，避免过渡期出现"两层字"
        setTimeout(function () {
          var inners = document.querySelectorAll('.page[data-page="' + index + '"] > .page-inner');
          for (var j = 0; j < inners.length; j++) inners[j].style.backgroundImage = 'none';
        }, 340);
      }
      im.onload = function () {
        if (typeof im.decode === 'function') {
          im.decode().then(finish, finish);
        } else { finish(); }
      };
      im.onerror = function () { s.pending = null; resolve(); };  // 保留 LQIP，不白屏
      im.src = url;
    });
    return s.pending;
  }

  function ensureAround(center) {
    var jobs = [];
    for (var d = -2; d <= 3; d++) {
      var i = center + d;
      if (i >= 0 && i < manifest.count) jobs.push(ensure(i));
    }
    return Promise.all(jobs);
  }

  /* ---------- 方向 / 文案 ---------- */
  function readOrientation() {
    if (flip) {
      try { return flip.getOrientation(); } catch (e) { /* noop */ }
    }
    return $('stage').getBoundingClientRect().width < BREAK ? 'portrait' : 'landscape';
  }

  function applyOrientation(o) {
    $('stage').setAttribute('data-orientation', o);
    $('stage').style.setProperty('--h-factor',
      String(o === 'portrait' ? manifest.ratio : 2 * manifest.ratio));
    fitStage(o);
    updateLabel();
  }

/* 按 topbar / toolbar 的真实占用算可用高度，避免书压住标题栏。
   注意：不能用 .app 的 clientHeight —— 书会把它撑大，形成循环。
   #book 的宽高必须显式写成 px：库用 element.offsetWidth/Height 当块宽高，
   交给 CSS 自适应时块宽会缩到内容宽度，书只有屏幕的一半大。 */
function fitStage(o) {
  var stage = $('stage');
  var book = $('book');
  var topbar = document.querySelector('.topbar');
  var toolbar = document.querySelector('.toolbar');
  var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  var availH = vh - topbar.offsetHeight - toolbar.offsetHeight - 28;
  var availW = Math.min(window.innerWidth - 24, 1600);
  var factor = o === 'portrait' ? manifest.ratio : 2 * manifest.ratio;
  var w = Math.max(300, Math.min(availW, availH * factor));
  var h = Math.round(w / factor);
  w = Math.round(w);
  stage.style.width = w + 'px';
  book.style.width = w + 'px';
  book.style.height = h + 'px';
}

  function updateLabel() {
    if (!flip || !manifest) return;
    var idx = flip.getCurrentPageIndex();
    var o = readOrientation();
    var txt;
    if (o === 'portrait') {
      txt = pageLabel(idx);
    } else {
      var sp = findSpread(idx, manifest.spreads.landscape);
      txt = sp.length === 2
        ? 'P' + (sp[0] + 1) + ' – P' + (sp[1] + 1)
        : pageLabel(sp[0]);
    }
    els.label.textContent = txt + '   ·   ' + (idx + 1) + '/' + manifest.count;
  }

  function updateButtons() {
    if (!flip) return;
    var idx = flip.getCurrentPageIndex();
    els.prev.disabled = idx <= 0;
    els.next.disabled = idx >= manifest.count - 1;
  }

  /* ---------- 页码持久化 ---------- */
  function readSavedPage() {
    var m = location.hash.match(/p=(\d+)/);
    if (m) return parseInt(m[1], 10);
    try {
      var s = sessionStorage.getItem('book-page');
      if (s !== null) return parseInt(s, 10);
    } catch (e) { /* noop */ }
    return 0;
  }

  function savePage(i) {
    try { sessionStorage.setItem('book-page', String(i)); } catch (e) { /* noop */ }
    try { history.replaceState(null, '', '#p=' + i); } catch (e) { /* noop */ }
  }

  /* ---------- 初始化翻页实例 ---------- */
  function initFlip() {
    var pageEls = buildPages();
    var W = 900;
    var H = Math.round(W / manifest.ratio);   // 单张竖版页的比例
    var saved = Math.max(0, Math.min(readSavedPage(), manifest.count - 1));

    flip = new St.PageFlip($('book'), {
      width: W, height: H,
      size: 'stretch',
      minWidth: BREAK / 2, minHeight: 480,
      maxWidth: 1000, maxHeight: 1600,
      usePortrait: true,        // 单实例自动切单/双页，不 destroy 不重建
      showCover: true,          // 封面/封底单独 + HARD，配对 [[0],[1,2],...,[M-1]]
      autoSize: true,
      startPage: saved,
      drawShadow: true, maxShadowOpacity: 0.6, flippingTime: 900,
      useMouseEvents: true, showPageCorners: true, disableFlipByClick: false,
      mobileScrollSupport: true, clickEventForward: true, swipeDistance: 30
    });

    // 必须先注册再 loadFromHTML：库用 setTimeout(...,1) 触发 init
    flip.on('init', function () {
      var o = readOrientation();
      lastOrientation = o;
      applyOrientation(o);
      updateButtons();
      ensureAround(flip.getCurrentPageIndex());
      $('loading').hidden = true;
      // 按最终方向收尾一次尺寸重算
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 80);
      diag();
      // QA 钩子：?open=toc（侧边目录）/ ?open=grid（缩略图）/ ?open=zoom
      var open = (location.search.match(/open=(\w+)/) || [])[1];
      if (open === 'toc') openDrawer();
      if (open === 'grid') openToc();
      if (open === 'zoom') openZoom();
      // QA 钩子：?qa=N 真实点击第 N 个菜品条目，验证事件委托 → gotoPage → 翻页 → 关闭抽屉
      var qa = (location.search.match(/qa=(\d+)/) || [])[1];
      if (qa !== undefined) {
        var entries = document.querySelectorAll('.toc-entry');
        if (entries[Number(qa)]) entries[Number(qa)].click();
      }
    });

    flip.on('flip', function () {
      var idx = flip.getCurrentPageIndex();
      savePage(idx);
      ensureAround(idx);
      updateLabel();
      updateButtons();
      syncToc(false);
    });

    flip.on('changeOrientation', function () {
      var o = readOrientation();
      if (o === lastOrientation) return;
      lastOrientation = o;
      applyOrientation(o);   // 只改文案与容器比例，不 destroy、不 turnToPage
      clearTimeout(updateTimer);
      updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 80);
    });

    // 翻页动画起点播一次纸声：库的 setState 先触发事件、后更新内部状态，
    // 因此必须用事件对象 e.data（新状态），flip.getState() 此时仍是旧值。
    // 拖拽页角、点击、键盘、目录/缩略图跳转都汇入这里，一次翻页只响一次（节流）。
    flip.on('changeState', function (e) {
      if (e && e.data === 'flipping') playFlipSound();
    });

    flip.loadFromHTML(pageEls);
  }

  /* ---------- 诊断：访问 ?diag 时把关键尺寸写进 title，便于无头浏览器核对 ---------- */
  /* ---------- 诊断：访问 ?diag 时把关键尺寸写进 title（开发者自查用，正常阅读无影响） ---------- */
  function diag() {
    if (location.search.indexOf('diag') < 0) return;
    var st = $('stage').getBoundingClientRect();
    var bk = $('book').getBoundingClientRect();
    document.title = 'DIAG vw' + window.innerWidth + ' vh' + window.innerHeight +
      ' stage' + Math.round(st.width) + 'x' + Math.round(st.height) +
      ' book' + Math.round(bk.width) + 'x' + Math.round(bk.height) +
      ' top' + Math.round(bk.top) + ' tb' + Math.round(document.querySelector('.toolbar').getBoundingClientRect().top) +
      ' ' + $('stage').getAttribute('data-orientation');
  }

  /* ---------- 侧边目录（两级：地域 → 菜品） ----------
     数据来自 assets/toc.v1.json（由 tools/toc.json 经 gen_toc.py 生成），
     前端只负责渲染与高亮，页码文案已由脚本算好。 */
  function loadToc() {
    return fetch('./assets/toc.v1.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('toc HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) {
        // 目录缺失不该阻断阅读：入口自动退回缩略图网格
        console.warn('[book] 目录数据加载失败，目录入口退回缩略图', e);
        return null;
      });
  }

  function buildTocTree() {
    if (tocBuilt || !toc) return;
    var tree = $('toc-tree');
    var frag = document.createDocumentFragment();

    toc.sections.forEach(function (s) {
      var ch = document.createElement('div');
      ch.className = 'toc-ch is-open';
      ch.setAttribute('data-section', String(s.index));

      var row = document.createElement('div');
      row.className = 'toc-ch__row';

      var jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'toc-ch__jump';
      jump.setAttribute('data-action', 'jump');
      jump.setAttribute('data-index', String(s.index));
      var no = document.createElement('span');
      no.className = 'toc-ch__no'; no.textContent = s.no;
      var area = document.createElement('span');
      area.className = 'toc-ch__area'; area.textContent = s.area;
      var sub = document.createElement('span');
      sub.className = 'toc-ch__sub'; sub.textContent = s.sub;
      jump.appendChild(no); jump.appendChild(area); jump.appendChild(sub);

      var tg = document.createElement('button');
      tg.type = 'button';
      tg.className = 'toc-ch__toggle';
      tg.setAttribute('data-action', 'toggle');
      tg.setAttribute('aria-expanded', 'true');
      tg.setAttribute('aria-label', s.area + ' 展开或收起');
      tg.textContent = '▼';

      row.appendChild(jump); row.appendChild(tg);
      ch.appendChild(row);

      var list = document.createElement('ol');
      list.className = 'toc-ch__list';
      s.items.forEach(function (it) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'toc-entry';
        b.setAttribute('data-action', 'jump');
        b.setAttribute('data-index', String(it.index));
        var name = document.createElement('span');
        name.className = 'toc-entry__name'; name.textContent = it.name;
        var lab = document.createElement('span');
        lab.className = 'toc-entry__label'; lab.textContent = it.label;
        b.appendChild(name); b.appendChild(lab);
        li.appendChild(b); list.appendChild(li);
      });
      ch.appendChild(list);
      frag.appendChild(ch);
    });

    tree.appendChild(frag);
    tocBuilt = true;
  }

  /* 当前页落在哪一章、哪道菜：章取「最后一个 index ≤ 当前页」，
     菜取当前章内 index ≤ 当前页 的最后一项（章首页落在章标题上、不高亮菜）。 */
  function syncToc(scroll) {
    if (!toc || !flip || !tocBuilt) return;
    var cur = flip.getCurrentPageIndex();
    var si = -1;
    for (var i = 0; i < toc.sections.length; i++) {
      if (cur >= toc.sections[i].index) si = i;
    }
    var chs = $('toc-tree').querySelectorAll('.toc-ch');
    var activeEl = null;
    for (var k = 0; k < chs.length; k++) {
      var isCur = (k === si);
      chs[k].classList.toggle('is-current', isCur);
      var entries = chs[k].querySelectorAll('.toc-entry');
      var hit = -1;
      for (var m = 0; m < entries.length; m++) {
        if (isCur && Number(entries[m].getAttribute('data-index')) <= cur) hit = m;
        entries[m].classList.remove('is-current');
      }
      if (hit >= 0) {
        entries[hit].classList.add('is-current');
        activeEl = entries[hit];
      }
    }
    if (scroll && activeEl) {
      var body = activeEl.closest('.toc-drawer__body');
      if (body) body.scrollTop = Math.max(0, activeEl.offsetTop - body.clientHeight * 0.34);
    }
  }

  function isDrawerOpen() {
    return $('toc-drawer').classList.contains('is-open');
  }

  function openDrawer() {
    if (!toc) { openToc(); return; }        // 无目录数据时退回缩略图
    buildTocTree();
    syncToc(true);
    $('toc-scrim').classList.add('is-open');
    $('toc-drawer').classList.add('is-open');
    $('toc-drawer').setAttribute('aria-hidden', 'false');
    $('toc-fab').setAttribute('aria-expanded', 'true');
    document.body.classList.add('toc-open');
  }

  function closeDrawer() {
    if (!isDrawerOpen()) return;
    $('toc-drawer').classList.remove('is-open');
    $('toc-scrim').classList.remove('is-open');
    $('toc-drawer').setAttribute('aria-hidden', 'true');
    $('toc-fab').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('toc-open');
  }

  function gotoPage(i) {
    closeDrawer();
    if (!canFlip()) return;
    playFlipSound();           // 与动画同步；changeState 会兜底，节流防重复
    flip.turnToPage(i);        // 先翻，响应跟手；LQIP 已垫底，不会白屏
    ensure(i);
    ensureAround(i);
  }

  /* ---------- 翻页音效（Web Audio 实时合成，零音频文件、零外链） ----------
     纸页摩擦声 = 滤波白噪声 + 快速起音/衰减包络，时长约 0.4s。
     库进入 'flipping'（动画开始）时播放，与翻页动画同步；拖拽、点击页角、
     目录跳转、键盘、缩略图跳转都统一走状态机，无需逐处埋点。 */
  var audioCtx = null;
  var soundOn = true;
  var lastSoundAt = 0;

  function audioCtxGet() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) {
      try { audioCtx = new AC(); } catch (e) { return null; }
    }
    // iOS Safari 首次必须在用户手势内 resume；翻页本身就是手势
    if (audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (e) { /* noop */ }
    }
    return audioCtx;
  }

  function playFlipSound() {
    if (!soundOn) return;
    var now = (window.performance && performance.now) ? performance.now() : Date.now();
    if (now - lastSoundAt < 240) return;      // 连翻节流，避免叠加爆音
    lastSoundAt = now;
    var ctx = audioCtxGet();
    if (!ctx) return;

    var dur = 0.40, rate = ctx.sampleRate;
    var len = Math.max(1, Math.floor(rate * dur));
    var buf = ctx.createBuffer(1, len, rate);
    var data = buf.getChannelData(0);
    var lp = 0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      lp = (lp + 0.035 * white) / 1.035;     // 少量低频成分，像纸而不像风
      data[i] = white * 0.72 + lp * 2.6;
    }

    var src = ctx.createBufferSource(); src.buffer = buf;
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1850; bp.Q.value = 0.6;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    // 起音快 → 主体沙沙 → 尾段纸页落定
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.13, t + 0.030);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.130);
    g.gain.exponentialRampToValueAtTime(0.030, t + 0.270);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(ctx.destination);
    try { src.start(t); src.stop(t + dur); } catch (e) { /* noop */ }
  }

  function setSound(on) {
    soundOn = !!on;
    try { localStorage.setItem('book-sound', soundOn ? '1' : '0'); } catch (e) { /* noop */ }
    var b = $('sound-btn');
    if (b) {
      b.textContent = soundOn ? '音效 开' : '音效 关';
      b.setAttribute('aria-pressed', soundOn ? 'true' : 'false');
    }
  }

  function initSound() {
    var saved = null;
    try { saved = localStorage.getItem('book-sound'); } catch (e) { /* noop */ }
    setSound(saved !== '0');                 // 默认开启
  }

  /* ---------- 交互 ---------- */
  function canFlip() {
    if (!flip) return false;
    try { return flip.getState() === 'read'; } catch (e) { return true; }
  }

  function goPrev() {
    if (canFlip() && flip.getCurrentPageIndex() > 0) { playFlipSound(); flip.flipPrev(); }
  }
  function goNext() {
    if (canFlip() && flip.getCurrentPageIndex() < manifest.count - 1) { playFlipSound(); flip.flipNext(); }
  }

  function closeOverlays() {
    $('zoom-overlay').hidden = true;
    $('toc-panel').hidden = true;
  }

  function openZoom() {
    if (!flip) return;
    var p = manifest.pages[flip.getCurrentPageIndex()];
    $('zoom-img').src = p.hi;
    $('zoom-overlay').hidden = false;
  }

  function buildToc() {
    var grid = $('toc-grid');
    if (grid.childElementCount) {
      var cur = flip.getCurrentPageIndex();
      var items = grid.querySelectorAll('.toc-item');
      for (var k = 0; k < items.length; k++) {
        items[k].classList.toggle('is-current',
          Number(items[k].getAttribute('data-index')) === cur);
      }
      return;
    }
    var frag = document.createDocumentFragment();
    manifest.pages.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toc-item';
      b.setAttribute('data-action', 'goto');
      b.setAttribute('data-index', String(p.index));
      var im = document.createElement('img');
      im.src = p.lo;
      im.alt = pageLabel(p.index);
      im.loading = 'lazy';
      var s = document.createElement('span');
      s.textContent = pageLabel(p.index);
      b.appendChild(im); b.appendChild(s);
      frag.appendChild(b);
    });
    grid.appendChild(frag);
  }

  function openToc() { buildToc(); $('toc-panel').hidden = false; }

  function toggleFullscreen() {
    var d = document;
    if (!d.fullscreenElement) {
      if (d.documentElement.requestFullscreen) {
        d.documentElement.requestFullscreen().catch(function () {});
      }
    } else if (d.exitFullscreen) {
      d.exitFullscreen().catch(function () {});
    }
  }

  function bindUI() {
    els.label = $('page-label');
    els.prev = document.querySelector('[data-action="prev"]');
    els.next = document.querySelector('[data-action="next"]');
    initSound();

    // iOS Safari 没有元素级全屏 API，直接隐藏按钮而不是留个点了没反应的键
    if (!document.documentElement.requestFullscreen) {
      var fsBtn = document.querySelector('[data-action="fullscreen"]');
      if (fsBtn) fsBtn.hidden = true;
    }

    document.querySelector('.toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      switch (btn.getAttribute('data-action')) {
        case 'prev': goPrev(); break;
        case 'next': goNext(); break;
        case 'toc': openDrawer(); break;
        case 'zoom': openZoom(); break;
        case 'fullscreen': toggleFullscreen(); break;
        case 'sound': setSound(!soundOn); break;
      }
    });

    /* 侧边目录：把手 / 遮罩 / 抽屉内部（关闭、跳转、折叠、缩略图入口） */
    $('toc-fab').addEventListener('click', openDrawer);
    $('toc-scrim').addEventListener('click', closeDrawer);
    $('toc-drawer').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var act = btn.getAttribute('data-action');
      if (act === 'close-drawer') { closeDrawer(); return; }
      if (act === 'open-grid') { closeDrawer(); openToc(); return; }
      if (act === 'toggle') {
        var ch = btn.closest('.toc-ch');
        var isOpen = ch.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        return;
      }
      if (act === 'jump') gotoPage(Number(btn.getAttribute('data-index')));
    });

    $('zoom-overlay').addEventListener('click', function (e) {
      if (e.target.closest('[data-action="close"]') || e.target === $('zoom-img')) closeOverlays();
    });
    $('toc-panel').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.getAttribute('data-action') === 'close') { closeOverlays(); return; }
      if (btn.getAttribute('data-action') === 'goto') {
        var i = Number(btn.getAttribute('data-index'));
        closeOverlays();
        if (canFlip()) { playFlipSound(); flip.turnToPage(i); }
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (isDrawerOpen()) { closeDrawer(); return; }
        closeOverlays(); return;
      }
      if (e.key === 'ArrowLeft') { goPrev(); return; }
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); goNext(); }
    });

    // 外层 resize 只做 UI 重排 + 一次收尾重算；方向切换由库内置的 window.resize 监听负责
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        var o = readOrientation();
        if (o !== lastOrientation) { lastOrientation = o; applyOrientation(o); }
        else { fitStage(o); updateLabel(); }
        clearTimeout(updateTimer);
        updateTimer = setTimeout(function () { try { flip.update(); } catch (e) {} }, 60);
        diag();
      }, 180);
    });
  }

  /* ---------- 启动 ---------- */
  Promise.all([loadManifest(), loadToc()]).then(function (res) {
    var m = res[0];
    toc = res[1];                 // 目录数据加载失败时为 null，入口自动退回缩略图
    manifest = m;
    if (m.count % 2 !== 0) throw new Error('manifest 页数必须为偶数');
    if (m.spreads.landscape[m.spreads.landscape.length - 1].length !== 1) {
      throw new Error('封底必须单独成页');
    }
    if (m.title) { $('book-title').textContent = m.title; document.title = m.title + ' · 网页版电子书'; }
    if (m.author) $('book-author').textContent = m.author;
    // 目录缩略图与书页共用同一比例，改可画画布比例时只需改 manifest
    document.documentElement.style.setProperty('--page-ratio', String(m.ratio));
    // 手机 / DPR1 平板用 lo 档，桌面 Retina 用 hi 档
    useHi = !(window.matchMedia && window.matchMedia('(max-width: 720px) and (max-resolution: 2dppx)').matches);
    bindUI();
    initFlip();
  }).catch(function (err) {
    $('loading').textContent = '载入失败：' + err.message + '（请用本地 http 服务打开，见 README）';
    console.error('[book]', err);
  });
})();
