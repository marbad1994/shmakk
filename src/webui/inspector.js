// Element inspector for design-mode previews.
//
// The preview iframe is served from an opaque (sandboxed) origin so generated
// pages cannot touch the app. To let the editor "point at" a live element we
// inject this tiny script into the HTML we serve (only when ?inspect=1 is in
// the artifact URL). It talks to the parent window over postMessage using a
// tiny protocol, and can apply text/style edits or delete an element in the
// live DOM. It never touches the app's cookies, storage or API.
//
// Note: nothing is injected as a visible element. An earlier version injected
// a <style> tag carrying the same data attribute as the outline, and its own
// rule (display:block!important) made the stylesheet's source render as text in
// the preview. Keep all injected nodes invisible.

const INSPECTOR_JS = `(function () {
  var KEY = 'shmakk-inspector';
  var ACTIVE = false;
  var SELECTED = null;
  var outline = null;
  var _uid = 0;

  // Computed properties we surface (and let the user override inline) even when
  // the element has no inline style of its own.
  var COMPUTED_PROPS = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'text-align', 'border-radius', 'opacity'];

  function post(msg) {
    try { window.parent.postMessage(Object.assign({ source: KEY }, msg), '*'); } catch (e) {}
  }

  function addOutline() {
    if (outline) return;
    outline = document.createElement('div');
    outline.setAttribute('data-shmakk-inspector', '1');
    outline.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;display:none;pointer-events:none;z-index:2147483646;border:1.5px solid #8b5cf6;background:rgba(139,92,246,0.08);box-sizing:border-box;transition:left 60ms ease,top 60ms ease,width 60ms ease,height 60ms ease;';
    if (document.body) document.body.appendChild(outline);
  }

  function placeOutline(el) {
    if (!el) return;
    addOutline();
    var r = el.getBoundingClientRect();
    outline.style.left = r.left + 'px';
    outline.style.top = r.top + 'px';
    outline.style.width = r.width + 'px';
    outline.style.height = r.height + 'px';
    outline.style.display = 'block';
  }

  function hideOutline() { if (outline) outline.style.display = 'none'; }

  function uid(el) {
    if (!el.__shmakkId) el.__shmakkId = 'el' + (++_uid);
    return el.__shmakkId;
  }

  function byId(id) {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) if (all[i].__shmakkId === id) return all[i];
    return null;
  }

  function esc(s) {
    try { return CSS.escape(String(s)); } catch (e) {
      return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; });
    }
  }

  function selector(el) {
    if (el.id) return '#' + esc(el.id);
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html') {
      var part = node.tagName.toLowerCase();
      if (node.classList && node.classList.length) {
        part += '.' + Array.prototype.map.call(node.classList, function (c) { return esc(c); }).join('.');
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function inlineStyles(el) {
    var out = {};
    var st = el.style;
    for (var i = 0; i < st.length; i++) {
      var name = st.item(i);
      if (!name) continue;
      out[name] = st.getPropertyValue(name);
    }
    return out;
  }

  function computedStyles(el, inline) {
    var out = {};
    try {
      var cs = getComputedStyle(el);
      for (var i = 0; i < COMPUTED_PROPS.length; i++) {
        var p = COMPUTED_PROPS[i];
        if (p in inline) continue;
        var v = cs.getPropertyValue(p);
        if (v && v.trim()) out[p] = v.trim();
      }
    } catch (e) {}
    return out;
  }

  function describe(el) {
    var hasChildren = el.children.length > 0;
    var styles = inlineStyles(el);
    return {
      tag: el.tagName.toLowerCase(),
      selector: selector(el),
      text: hasChildren ? '' : (el.textContent || '').trim(),
      hasChildren: hasChildren,
      styles: styles,
      computed: computedStyles(el, styles),
    };
  }

  function select(el) {
    SELECTED = el;
    if (el) {
      placeOutline(el);
      post({ type: 'selected', id: uid(el), detail: describe(el) });
    } else {
      hideOutline();
      post({ type: 'cleared' });
    }
  }

  function serialize() {
    var clone = document.documentElement.cloneNode(true);
    var remove = clone.querySelectorAll('[data-shmakk-inspector]');
    for (var i = 0; i < remove.length; i++) {
      if (remove[i].parentNode) remove[i].parentNode.removeChild(remove[i]);
    }
    return '<!DOCTYPE html>' + clone.outerHTML;
  }

  function onOver(e) {
    if (!ACTIVE) return;
    var el = e.target;
    if (!el || el === outline || (el.getAttribute && el.getAttribute('data-shmakk-inspector'))) return;
    placeOutline(el);
  }

  function onClick(e) {
    if (!ACTIVE) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === outline || (el.getAttribute && el.getAttribute('data-shmakk-inspector'))) return;
    select(el);
  }

  function onKey(e) {
    if (!ACTIVE) return;
    if (e.key === 'Escape') select(null);
  }

  function enable() {
    if (ACTIVE) return;
    ACTIVE = true;
    addOutline();
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    post({ type: 'mode', enabled: true });
  }

  function disable() {
    ACTIVE = false;
    hideOutline();
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    post({ type: 'mode', enabled: false });
  }

  function applyStyles(el, styles) {
    var keys = Object.keys(styles);
    for (var i = 0; i < keys.length; i++) {
      var prop = keys[i];
      var val = styles[prop];
      if (val === null || val === undefined) el.style.removeProperty(prop);
      else el.style.setProperty(prop, String(val));
    }
  }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || msg.source !== KEY) return;
    if (msg.type === 'enable') { enable(); return; }
    if (msg.type === 'disable') { disable(); return; }
    if (msg.type === 'clear') { select(null); return; }
    if (msg.type === 'update') {
      var el = byId(msg.id);
      if (!el) { post({ type: 'updated', ok: false, error: 'element gone' }); return; }
      if (typeof msg.text === 'string') el.textContent = msg.text;
      if (msg.styles && typeof msg.styles === 'object') applyStyles(el, msg.styles);
      select(el);
      post({ type: 'updated', ok: true, id: uid(el), html: serialize() });
      return;
    }
    if (msg.type === 'remove') {
      var el2 = byId(msg.id);
      if (!el2) { post({ type: 'removed', ok: false, error: 'element gone' }); return; }
      if (el2.parentNode) el2.parentNode.removeChild(el2);
      select(null);
      post({ type: 'removed', ok: true, html: serialize() });
      return;
    }
  });

  post({ type: 'ready' });
})();`;

function injectInspector(html) {
  // Injected node is a plain <script> (never rendered) with no companion <style>.
  const script = '<script data-shmakk-inspector>' + INSPECTOR_JS + '</' + 'script>';
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, script + '</body>');
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, script + '</html>');
  return html + script;
}

module.exports = { injectInspector };
