// Code inspector injected into pages served through the preview proxy.
//
// Inert until the browser pane sends { type: 'enable' }. While enabled the
// user can hover and click an element; the inspector reports what it is in
// terms the middle layer can ground in the codebase:
//   • a stable-ish selector, tag, text, attributes and an outerHTML excerpt;
//   • framework source hints: the React component (and, in dev builds, the
//     file and line from _debugSource or _debugStack), Vue's __file, Svelte's
//     __svelte_meta, Angular's component class, and data-source style attrs;
//   • computed styles for the properties a person usually wants to tweak.
// Style and text tweaks applied here are preview-only. They show the intent;
// the real change is made in source by the plan the request turns into.
//
// It also reports navigation (including SPA pushState) so the pane's address
// bar follows the page. Messages go to window.parent only.

const INSPECTOR_SOURCE = `(function () {
  if (window.__shmakkPreview) return;
  window.__shmakkPreview = true;
  var KEY = 'shmakk-preview';
  var parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  var ACTIVE = false, box = null, tag = null, selected = null, uidSeq = 0, picked = [];
  var STYLE_PROPS = ['color','background-color','font-family','font-size','font-weight','line-height','text-align','padding','margin','gap','border','border-radius','width','height','display','opacity'];

  function post(msg) { try { msg.source = KEY; parentWin.postMessage(msg, '*'); } catch (e) {} }
  function nav() { post({ type: 'nav', href: location.href, path: location.pathname + location.search + location.hash, title: document.title }); }
  ['pushState','replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); setTimeout(nav, 0); return r; };
  });
  window.addEventListener('popstate', nav);
  window.addEventListener('hashchange', nav);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', nav); else nav();
  window.addEventListener('load', nav);

  function mk() {
    if (box) return;
    box = document.createElement('div');
    box.setAttribute('data-shmakk-preview', '1');
    box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #7c5cff;background:rgba(124,92,255,.08);border-radius:3px;display:none;box-sizing:border-box;transition:all 50ms ease-out';
    tag = document.createElement('div');
    tag.setAttribute('data-shmakk-preview', '1');
    tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#7c5cff;color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
    (document.body || document.documentElement).appendChild(box);
    (document.body || document.documentElement).appendChild(tag);
  }
  function place(el) {
    mk();
    var r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px'; box.style.width = r.width + 'px'; box.style.height = r.height + 'px'; box.style.display = 'block';
    var c = component(el);
    tag.textContent = (c && c.name ? c.name + ' ' : '') + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
    tag.style.left = Math.max(0, r.left) + 'px';
    tag.style.top = Math.max(0, r.top - 20) + 'px';
    tag.style.display = 'block';
  }
  function hide() { if (box) box.style.display = 'none'; if (tag) tag.style.display = 'none'; }
  function ours(el) { return !el || (el.getAttribute && el.getAttribute('data-shmakk-preview')); }

  function cssEsc(s) { try { return CSS.escape(String(s)); } catch (e) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); } }
  function selector(el) {
    if (el.id && document.querySelectorAll('#' + cssEsc(el.id)).length === 1) return '#' + cssEsc(el.id);
    var tid = el.getAttribute('data-testid') || el.getAttribute('data-test');
    if (tid) return '[data-testid="' + tid + '"]';
    var parts = [], node = el, depth = 0;
    while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
      var p = node.tagName.toLowerCase();
      var cls = Array.prototype.filter.call(node.classList || [], function (c) { return !/^(css|sc|jsx|emotion|svelte)-|[0-9a-f]{6,}/i.test(c); }).slice(0, 2);
      if (cls.length) p += '.' + cls.map(cssEsc).join('.');
      var parent = node.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === node.tagName; });
        if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(p);
      if (node.id) { parts[0] = '#' + cssEsc(node.id); break; }
      node = parent; depth++;
    }
    return parts.join(' > ');
  }

  function stackLoc(stack) {
    var lines = String(stack || '').split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /(?:at\\s+(?:([\\w$.<>]+)\\s+)?\\(?|@)(https?:\\/\\/[^)\\s]+?):(\\d+):(\\d+)\\)?\\s*$/.exec(lines[i]);
      if (!m) continue;
      var u = m[2];
      if (/node_modules|\\/@vite\\/|\\/@react-refresh|react-dom|chunk-|\\.vite\\/deps/.test(u)) continue;
      try { var url = new URL(u); return { file: decodeURIComponent(url.pathname).replace(/^\\/@fs/, ''), line: Number(m[3]), approx: true }; } catch (e) {}
    }
    return null;
  }
  function component(el) {
    try {
      var keys = Object.keys(el), i, k;
      for (i = 0; i < keys.length; i++) {
        k = keys[i];
        if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) {
          var f = el[k], chain = [], first = null, src = null;
          // The element's own creation site is the most precise location.
          if (f._debugSource) src = { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
          else if (f._debugStack) src = stackLoc(f._debugStack.stack || f._debugStack);
          while (f) {
            var t = f.type;
            if (t && typeof t === 'function') {
              var n = t.displayName || t.name;
              if (n && chain.length < 6) chain.push(n);
              if (!first) first = n;
              if (!src && f._debugSource) src = { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
              if (!src && f._debugStack) src = stackLoc(f._debugStack.stack || f._debugStack);
            }
            if (!src && f._debugSource && f.tag === 5) src = { file: f._debugSource.fileName, line: f._debugSource.lineNumber };
            f = f.return;
          }
          if (first || src) return { framework: 'react', name: first, chain: chain, file: src && src.file, line: src && src.line, approx: !!(src && src.approx) };
        }
      }
      var node = el;
      while (node && node.nodeType === 1) {
        if (node.__vueParentComponent) {
          var c = node.__vueParentComponent, vt = c.type || {};
          return { framework: 'vue', name: vt.name || vt.__name || null, file: vt.__file || null };
        }
        if (node.__vue__) { var o = node.__vue__.$options || {}; return { framework: 'vue', name: o.name || null, file: o.__file || null }; }
        if (node.__svelte_meta && node.__svelte_meta.loc) { var l = node.__svelte_meta.loc; return { framework: 'svelte', name: null, file: l.file, line: l.line }; }
        var ds = node.getAttribute && (node.getAttribute('data-source') || node.getAttribute('data-loc') || node.getAttribute('data-inspector-relative-path'));
        if (ds) { var mm = /^(.*?)(?::(\\d+))?(?::\\d+)?$/.exec(ds); return { framework: 'attr', name: null, file: mm[1], line: mm[2] ? Number(mm[2]) : null }; }
        node = node.parentElement;
      }
      if (window.ng && window.ng.getComponent) {
        node = el;
        while (node && node.nodeType === 1) {
          var cmp = window.ng.getComponent(node);
          if (cmp) return { framework: 'angular', name: cmp.constructor && cmp.constructor.name, file: null };
          node = node.parentElement;
        }
      }
    } catch (e) {}
    return null;
  }

  function attrs(el) {
    var out = {}, names = ['id','class','name','type','role','aria-label','href','src','alt','placeholder','title','data-testid','for','action','method'];
    for (var i = 0; i < names.length; i++) { var v = el.getAttribute(names[i]); if (v) out[names[i]] = String(v).slice(0, 200); }
    return out;
  }
  function styles(el) {
    var out = {};
    try { var cs = getComputedStyle(el); STYLE_PROPS.forEach(function (p) { var v = cs.getPropertyValue(p); if (v) out[p] = v.trim(); }); } catch (e) {}
    return out;
  }
  function uid(el) { if (!el.__shmakkUid) el.__shmakkUid = 'p' + (++uidSeq); return el.__shmakkUid; }
  function find(id) { for (var i = 0; i < picked.length; i++) if (picked[i].__shmakkUid === id) return picked[i]; return null; }
  function describe(el) {
    var r = el.getBoundingClientRect();
    var html = el.outerHTML || '';
    var landmarks = [], n = el.parentElement;
    while (n && landmarks.length < 4) {
      var lt = n.tagName.toLowerCase();
      if (/^(header|nav|main|aside|footer|form|section|dialog|table)$/.test(lt) || n.getAttribute('role')) {
        var lbl = n.getAttribute('aria-label') || (n.querySelector('h1,h2,h3,legend,caption') || {}).textContent || '';
        landmarks.push(lt + (lbl ? ' "' + String(lbl).trim().slice(0, 40) + '"' : ''));
      }
      n = n.parentElement;
    }
    return {
      tag: el.tagName.toLowerCase(),
      selector: selector(el),
      text: (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
      html: html.length > 1800 ? html.slice(0, 1800) + '...' : html,
      attrs: attrs(el),
      styles: styles(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      viewport: { w: innerWidth, h: innerHeight },
      landmarks: landmarks,
      component: component(el),
      page: { href: location.href, path: location.pathname + location.search, title: document.title },
    };
  }

  function onOver(e) { if (ACTIVE && !ours(e.target)) place(e.target); }
  function onClick(e) {
    if (!ACTIVE) return;
    if (ours(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation();
    selected = e.target;
    if (picked.indexOf(selected) === -1) picked.push(selected);
    place(selected);
    post({ type: 'selected', id: uid(selected), detail: describe(selected) });
  }
  function swallow(e) { if (ACTIVE && !ours(e.target)) { e.preventDefault(); e.stopPropagation(); } }
  function onKey(e) { if (ACTIVE && e.key === 'Escape') { selected = null; hide(); post({ type: 'cleared' }); } }
  function onScroll() { if (ACTIVE && selected) place(selected); }

  function enable() {
    if (ACTIVE) return;
    ACTIVE = true;
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('submit', swallow, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    document.documentElement.style.cursor = 'crosshair';
    post({ type: 'mode', enabled: true });
  }
  function disable() {
    ACTIVE = false; selected = null; hide();
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('submit', swallow, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    document.documentElement.style.cursor = '';
    post({ type: 'mode', enabled: false });
  }

  window.addEventListener('message', function (e) {
    if (e.source !== parentWin) return;
    var m = e.data;
    if (!m || m.source !== KEY) return;
    if (m.type === 'enable') return enable();
    if (m.type === 'disable') return disable();
    if (m.type === 'ping') return post({ type: 'ready' });
    if (m.type === 'back') return history.back();
    if (m.type === 'forward') return history.forward();
    if (m.type === 'reload') return location.reload();
    if (m.type === 'clear') { selected = null; hide(); return; }
    if (m.type === 'tweak') {
      var el = find(m.id);
      if (!el) return post({ type: 'tweaked', ok: false, id: m.id });
      if (typeof m.text === 'string' && !el.children.length) el.textContent = m.text;
      if (m.styles) Object.keys(m.styles).forEach(function (p) { var v = m.styles[p]; if (v == null || v === '') el.style.removeProperty(p); else el.style.setProperty(p, String(v)); });
      if (selected === el) place(el);
      return post({ type: 'tweaked', ok: true, id: m.id, detail: describe(el) });
    }
  });
  post({ type: 'ready' });
})();`;

module.exports = { INSPECTOR_SOURCE };
