// shmakk Browser Automator extension content script.
// Injects an automation-only overlay and executes approved actions in-page.

(() => {
  if (window.__shmakkBrowserAutomatorLoaded) return;
  window.__shmakkBrowserAutomatorLoaded = true;
  if (location.href === "about:blank") return;
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", init, { once: true });
    return;
  }
  init();

  function init() {
    const ICONS = {
      bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
      record: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
      stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
      trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    };

    const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.puck {
  position: fixed; right: 18px; bottom: 18px; z-index: 2147483646;
  width: 46px; height: 46px; border-radius: 14px; border: 1px solid #2c2f38;
  background: #16181d; color: #e8a33d; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 6px 24px rgba(0,0,0,.45); transition: transform .15s ease;
}
.puck:hover { transform: scale(1.06); }
.puck svg { width: 22px; height: 22px; }
.puck.rec { color: #e25555; animation: pulse 1.2s infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 8px rgba(226,85,85,.18); } }
.panel {
  position: fixed; right: 18px; bottom: 76px; z-index: 2147483646;
  width: 360px; max-width: calc(100vw - 28px); display: none; flex-direction: column;
  background: #16181d; color: #e7e9ee; border: 1px solid #2c2f38;
  border-radius: 14px; box-shadow: 0 16px 48px rgba(0,0,0,.5);
}
.panel.open { display: flex; }
.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #23262e; cursor: grab; user-select: none; }
.head.dragging { cursor: grabbing; }
.title { color: #e8a33d; font-size: 13px; font-weight: 650; letter-spacing: .03em; }
.model { margin-left: auto; color: #8b909d; font-size: 11px; max-width: 145px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #5a5f6b; flex: 0 0 auto; }
.dot.on { background: #58c789; }
.body { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
textarea {
  width: 100%; min-height: 78px; max-height: 150px; resize: vertical; outline: none;
  padding: 9px 10px; border-radius: 10px; border: 1px solid #2c2f38;
  background: #101217; color: #e7e9ee; font-size: 12.5px; line-height: 1.45;
}
textarea:focus { border-color: #5b9bd5; }
.controls { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  min-height: 31px; padding: 6px 10px; border-radius: 8px; border: 1px solid #2c2f38;
  background: #1d2026; color: #cfd3dc; font-size: 11.5px; cursor: pointer;
}
.btn:hover { background: #262a32; border-color: #3a3e49; }
.btn.primary { background: #243448; border-color: #3a5068; color: #9cc7f1; font-weight: 600; }
.btn.rec { background: #2c1717; border-color: #6b2323; color: #ef7777; }
.btn.danger { margin-left: auto; color: #d17575; }
.btn svg { width: 13px; height: 13px; flex: 0 0 auto; }
.history {
  min-height: 92px; max-height: 190px; overflow-y: auto; padding: 9px 10px;
  border: 1px solid #23262e; border-radius: 10px; background: #101217;
  color: #aeb4c1; font-size: 12px; line-height: 1.4;
}
.history strong { color: #e7e9ee; font-weight: 600; }
.steps { margin-top: 6px; padding-left: 17px; color: #8b909d; }
.steps li { margin: 3px 0; }
.statusline { color: #8b909d; }
.running { color: #e8a33d; }
.error { color: #ef7777; }
.indicator {
  position: fixed; top: 12px; right: 12px; z-index: 2147483647;
  padding: 6px 12px; border-radius: 8px; background: #16181d; color: #e8a33d;
  font: 12px system-ui, sans-serif; border: 1px solid #2c2f38;
  box-shadow: 0 4px 16px rgba(0,0,0,.4); pointer-events: none;
}
.target {
  position: fixed; z-index: 2147483646; border: 2px solid #e8a33d; border-radius: 4px;
  background: rgba(232,163,61,.12); transition: all .15s ease; pointer-events: none; display: none;
}
`;

    const host = document.createElement("div");
    host.id = "__shmakk_browser_automator_host";
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    const puck = document.createElement("button");
    puck.className = "puck";
    puck.type = "button";
    puck.title = "Browser Automator";
    puck.innerHTML = ICONS.bolt;
    root.appendChild(puck);

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.innerHTML = `
      <div class="head" id="head">
        ${ICONS.bolt}<span class="title">Browser Automator</span>
        <span class="model" id="model">daemon</span><span class="dot" id="dot"></span>
      </div>
      <div class="body">
        <textarea id="instruction" rows="3" placeholder="Describe what to automate..."></textarea>
        <div class="controls">
          <button class="btn primary" id="runBtn" type="button">${ICONS.play} Run</button>
          <button class="btn" id="recordBtn" type="button">${ICONS.record} Record</button>
          <button class="btn" id="stopBtn" type="button">${ICONS.stop} Stop</button>
          <button class="btn danger" id="clearBtn" type="button">${ICONS.trash} Clear</button>
        </div>
        <div class="history" id="history"></div>
      </div>
    `;
    root.appendChild(panel);

    const ui = {
      puck,
      panel,
      head: panel.querySelector("#head"),
      model: panel.querySelector("#model"),
      dot: panel.querySelector("#dot"),
      instruction: panel.querySelector("#instruction"),
      runBtn: panel.querySelector("#runBtn"),
      recordBtn: panel.querySelector("#recordBtn"),
      stopBtn: panel.querySelector("#stopBtn"),
      clearBtn: panel.querySelector("#clearBtn"),
      history: panel.querySelector("#history"),
    };

    let tabId = "unknown";
    let storageKey = null;
    let connected = false;
    let recording = false;
    let running = false;
    let lastInputValue = new WeakMap();
    let scrollTimer = null;
    let state = {
      draft: "",
      actions: [],
      steps: [],
      panelOpen: false,
      lastStatus: "Ready. Start shmakk browser-daemon to enable typed automation.",
      updatedAt: Date.now(),
    };

    function send(msg, cb) {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          running = false;
          setStatus(chrome.runtime.lastError.message, true);
          render();
          if (cb) cb(null);
          return;
        }
        if (cb) cb(resp);
      });
    }

    function pageKey() {
      try {
        const u = new URL(location.href);
        return `${u.origin}${u.pathname}`;
      } catch {
        return location.href.split("#")[0].split("?")[0];
      }
    }

    function setStorageKey(id) {
      tabId = id || "unknown";
      storageKey = `browserAutomator:${tabId}:${pageKey()}`;
    }

    function loadState() {
      if (!storageKey) return Promise.resolve();
      return new Promise((resolve) => {
        chrome.storage.local.get(storageKey, (data) => {
          const saved = data && data[storageKey];
          if (saved && typeof saved === "object") {
            state = {
              ...state,
              ...saved,
              actions: Array.isArray(saved.actions) ? saved.actions : [],
              steps: Array.isArray(saved.steps) ? saved.steps : [],
            };
          }
          ui.instruction.value = state.draft || "";
          ui.panel.classList.toggle("open", !!state.panelOpen);
          render();
          resolve();
        });
      });
    }

    function persist() {
      if (!storageKey) return;
      state.draft = ui.instruction.value;
      state.panelOpen = ui.panel.classList.contains("open");
      state.updatedAt = Date.now();
      chrome.storage.local.set({ [storageKey]: state });
    }

    function clearPersisted() {
      if (storageKey) chrome.storage.local.remove(storageKey);
    }

    function setStatus(text, isError = false) {
      state.lastStatus = text || "";
      state.statusError = !!isError;
      render();
      persist();
    }

    function render() {
      ui.dot.classList.toggle("on", connected);
      ui.puck.classList.toggle("rec", recording);
      ui.recordBtn.classList.toggle("rec", recording);
      ui.recordBtn.disabled = recording || running;
      ui.stopBtn.disabled = !recording || running;
      ui.runBtn.disabled = recording || running;
      const count = state.actions.length;
      const statusClass = running ? "running" : state.statusError ? "error" : "statusline";
      const steps = state.steps.slice(-8).map((s) => `<li>${escapeHTML(s)}</li>`).join("");
      ui.history.innerHTML = `
        <div><strong>${count}</strong> recorded step${count === 1 ? "" : "s"}</div>
        <div class="${statusClass}">${escapeHTML(state.lastStatus || "Ready.")}</div>
        ${steps ? `<ol class="steps">${steps}</ol>` : ""}
      `;
    }

    function escapeHTML(s) {
      return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    }

    function cssPath(el) {
      if (!el || el.nodeType !== 1 || isOverlayElement(el)) return "";
      if (el.id) return `#${CSS.escape(el.id)}`;
      const preferred = ["data-testid", "data-test", "aria-label", "placeholder", "title", "name"];
      for (const attr of preferred) {
        const val = el.getAttribute(attr);
        if (val) return `${el.tagName.toLowerCase()}[${attr}="${cssAttr(val)}"]`;
      }
      const classes = Array.from(el.classList || []).filter(Boolean).slice(0, 2);
      if (classes.length) return `${el.tagName.toLowerCase()}.${classes.map((c) => CSS.escape(c)).join(".")}`;
      let path = el.tagName.toLowerCase();
      let cur = el;
      while (cur.parentElement && cur.parentElement !== document.body && path.length < 180) {
        const parent = cur.parentElement;
        const tag = cur.tagName.toLowerCase();
        const siblings = Array.from(parent.children).filter((n) => n.tagName === cur.tagName);
        const idx = siblings.indexOf(cur) + 1;
        path = `${tag}:nth-of-type(${idx}) > ${path}`;
        cur = parent;
      }
      return path;
    }

    function cssAttr(value) {
      return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    }

    function isOverlayElement(el) {
      const node = el && el.getRootNode && el.getRootNode();
      return node === root || el === host || (el.closest && el.closest("#__shmakk_browser_automator_host"));
    }

    function addRecordedAction(action, label) {
      if (!recording || !action || isOverlayElement(document.activeElement)) return;
      state.actions.push({ ...action, description: action.description || label });
      state.steps.push(label || action.action);
      setStatus(`Recording: ${state.actions.length} step${state.actions.length === 1 ? "" : "s"}.`);
    }

    function elementText(el) {
      return (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 80);
    }

    function onClick(e) {
      if (!recording || isOverlayElement(e.target)) return;
      const selector = cssPath(e.target);
      if (!selector) return;
      addRecordedAction({ action: "click", selector }, `Click ${elementText(e.target) || selector}`);
    }

    function onFocusIn(e) {
      if (!isFormish(e.target)) return;
      lastInputValue.set(e.target, valueOf(e.target));
    }

    function onChange(e) {
      if (!recording || !isFormish(e.target) || isOverlayElement(e.target)) return;
      const selector = cssPath(e.target);
      if (!selector) return;
      const value = valueOf(e.target);
      if (lastInputValue.get(e.target) === value) return;
      lastInputValue.set(e.target, value);
      const action = e.target.tagName === "SELECT"
        ? { action: "select", selector, value }
        : { action: "type", selector, value, delay: 20 };
      addRecordedAction(action, `Set ${selector}`);
    }

    function onKeyDown(e) {
      if (!recording || isOverlayElement(e.target)) return;
      if (e.key !== "Enter") return;
      const selector = cssPath(e.target);
      addRecordedAction({ action: "press", selector, key: "Enter" }, `Press Enter${selector ? ` in ${selector}` : ""}`);
    }

    function onScroll() {
      if (!recording) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        addRecordedAction({ action: "scroll", y: Math.round(window.scrollY) }, `Scroll to ${Math.round(window.scrollY)}px`);
      }, 250);
    }

    function isFormish(el) {
      if (!el || el.nodeType !== 1) return false;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
    }

    function valueOf(el) {
      if (el.isContentEditable) return el.textContent || "";
      if (el.type === "checkbox" || el.type === "radio") return el.checked ? "true" : "false";
      return el.value || "";
    }

    function prunedDOM() {
      const clone = document.body.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, svg, link, meta, #__shmakk_browser_automator_host").forEach((n) => n.remove());
      const walker = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
      const parts = [];
      let n;
      while ((n = walker.nextNode()) && parts.length < 220) {
        const tag = n.tagName.toLowerCase();
        const attrs = ["id", "class", "name", "type", "href", "aria-label", "placeholder", "title", "role", "data-testid"]
          .map((a) => n.getAttribute(a) ? `${a}="${String(n.getAttribute(a)).slice(0, 90)}"` : "")
          .filter(Boolean)
          .join(" ");
        const text = (n.innerText || n.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90);
        if (attrs || text) parts.push(`<${tag}${attrs ? " " + attrs : ""}>${text}`);
      }
      return parts.join("\n").slice(0, 12000);
    }

    function captureScreenshot() {
      return new Promise((resolve) => {
        send({ type: "captureScreenshot" }, (resp) => resolve(resp && resp.data ? resp.data : null));
      });
    }

    async function run() {
      if (running || recording) return;
      const text = ui.instruction.value.trim();
      if (!text && state.actions.length) {
        await executeActions(state.actions, `Replaying ${state.actions.length} recorded step${state.actions.length === 1 ? "" : "s"}`);
        return;
      }
      if (!text) {
        setStatus("Enter an instruction or record steps first.", true);
        return;
      }
      running = true;
      render();
      setStatus("Sending automation request to daemon...");
      const screenshot = await captureScreenshot();
      const payload = {
        type: "automation",
        url: location.href,
        title: document.title,
        text,
        instructions: [text],
        dom: prunedDOM(),
        screenshots: screenshot ? [screenshot] : [],
      };
      send(payload);
    }

    async function executeActions(actions, summary = "Running automation", notes = "") {
      const list = Array.isArray(actions) ? actions : [];
      if (!list.length) {
        setStatus("No executable actions were produced.", true);
        return;
      }
      running = true;
      render();
      const indicator = document.createElement("div");
      indicator.className = "indicator";
      document.body.appendChild(indicator);
      const targetBox = document.createElement("div");
      targetBox.className = "target";
      document.body.appendChild(targetBox);
      let completed = 0;
      try {
        for (let i = 0; i < list.length; i++) {
          const act = list[i] || {};
          indicator.textContent = `[${i + 1}/${list.length}] ${act.description || act.action || "action"}`;
          const el = findTarget(act.selector);
          highlight(targetBox, el);
          await executeAction(act, el);
          completed++;
          await sleep(Number(act.afterMs) || 120);
        }
        setStatus(`Completed ${completed} action${completed === 1 ? "" : "s"}. ${summary || ""}${notes ? ` ${notes}` : ""}`.trim());
      } catch (err) {
        setStatus(err && err.message ? err.message : String(err), true);
      } finally {
        targetBox.remove();
        indicator.remove();
        running = false;
        render();
        persist();
      }
    }

    function findTarget(selector) {
      if (!selector) return null;
      try { return document.querySelector(selector); } catch { return null; }
    }

    function highlight(box, el) {
      if (!el) {
        box.style.display = "none";
        return;
      }
      const r = el.getBoundingClientRect();
      box.style.display = "block";
      box.style.left = `${r.left - 2}px`;
      box.style.top = `${r.top - 2}px`;
      box.style.width = `${r.width + 4}px`;
      box.style.height = `${r.height + 4}px`;
    }

    async function executeAction(act, el) {
      switch (act.action) {
        case "newTab":
        case "reload":
        case "closeTab":
        case "switchTab":
        case "createGroup":
        case "moveToGroup":
        case "ungroup": {
          const result = await executeTabAction(act);
          if (result && result.error) throw new Error(result.error);
          break;
        }
        case "navigate":
          if (!act.url) throw new Error("navigate action requires a URL");
          location.href = act.url;
          await sleep(1500);
          break;
        case "waitSelector":
          for (let i = 0; i < 30; i++) {
            if (findTarget(act.selector)) return;
            await sleep(250);
          }
          throw new Error(`Selector not found: ${act.selector}`);
        case "wait":
          await sleep(Number(act.ms) || 1000);
          break;
        case "click":
          if (!el) throw new Error(`Selector not found for click: ${act.selector}`);
          el.scrollIntoView({ block: "center", inline: "center" });
          await sleep(80);
          el.click();
          break;
        case "type":
          if (!el) throw new Error(`Selector not found for type: ${act.selector}`);
          await setElementValue(el, act.value || "", Number(act.delay) || 0);
          break;
        case "press": {
          const target = el || document.activeElement || document.body;
          if (el) el.focus();
          for (const type of ["keydown", "keypress", "keyup"]) {
            target.dispatchEvent(new KeyboardEvent(type, { key: act.key || "Enter", bubbles: true, cancelable: true }));
          }
          break;
        }
        case "hover":
          if (!el) throw new Error(`Selector not found for hover: ${act.selector}`);
          dispatchMouse(el, "mouseover");
          dispatchMouse(el, "mouseenter");
          break;
        case "select":
          if (!el) throw new Error(`Selector not found for select: ${act.selector}`);
          el.value = act.value || "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          break;
        case "scroll":
          if (act.to === "bottom") window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
          else if (act.to === "top") window.scrollTo({ top: 0, behavior: "auto" });
          else if (typeof act.y === "number") window.scrollTo({ top: act.y, behavior: "auto" });
          else if (el) el.scrollIntoView({ block: "center", inline: "center" });
          else window.scrollBy({ top: Number(act.dy) || 500, behavior: "auto" });
          break;
        default:
          throw new Error(`Unknown action: ${act.action}`);
      }
    }

    async function setElementValue(el, value, delay) {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.focus();
      if (el.isContentEditable) el.textContent = "";
      else if ("value" in el) el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
      for (const ch of String(value)) {
        if (el.isContentEditable) el.textContent += ch;
        else if ("value" in el) el.value += ch;
        for (const type of ["keydown", "keypress", "keyup"]) {
          el.dispatchEvent(new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true }));
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (delay) await sleep(delay);
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function dispatchMouse(el, type) {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: type !== "mouseenter",
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }));
    }

    function executeTabAction(action) {
      return new Promise((resolve) => {
        send({ type: "executeTabAction", action }, (resp) => resolve(resp || { ok: true }));
      });
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function startRecording() {
      if (running || recording) return;
      recording = true;
      addRecordedAction({ action: "wait", ms: 250 }, `Start on ${location.href}`);
      setStatus("Recording. Interact with the page normally, then press Stop.");
      render();
    }

    function stopRecording() {
      if (!recording) return;
      recording = false;
      setStatus(`Stopped recording with ${state.actions.length} step${state.actions.length === 1 ? "" : "s"}. Press Run to replay.`);
      render();
      persist();
    }

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "connected") {
        connected = true;
        setStatus("Daemon connected.");
      } else if (msg.type === "disconnected") {
        connected = false;
        setStatus("Daemon disconnected. Run shmakk browser-daemon.", true);
      } else if (msg.type === "hello") {
        connected = true;
        ui.model.textContent = msg.model || "daemon";
        setStatus("Daemon connected.");
      } else if (msg.type === "status") {
        setStatus(msg.text || "Daemon status updated.");
      } else if (msg.type === "automationResult") {
        running = false;
        setStatus(msg.summary || (msg.ok ? "Automation request complete." : "Automation failed."), !msg.ok);
        render();
      } else if (msg.type === "executeActions") {
        executeActions(msg.actions || [], msg.summary || "Automation", msg.notes || "");
      } else if (msg.type === "error") {
        running = false;
        setStatus(msg.text || "Daemon error.", true);
        render();
      }
    });

    ui.puck.addEventListener("click", () => {
      ui.panel.classList.toggle("open");
      persist();
    });
    ui.instruction.addEventListener("input", persist);
    ui.runBtn.addEventListener("click", run);
    ui.recordBtn.addEventListener("click", startRecording);
    ui.stopBtn.addEventListener("click", stopRecording);
    ui.clearBtn.addEventListener("click", () => {
      state.actions = [];
      state.steps = [];
      state.draft = "";
      state.lastStatus = "Cleared.";
      state.statusError = false;
      ui.instruction.value = "";
      clearPersisted();
      render();
    });

    document.addEventListener("click", onClick, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("change", onChange, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("beforeunload", persist);

    (() => {
      let dragging = false, sx = 0, sy = 0, px = 0, py = 0;
      ui.head.addEventListener("mousedown", (e) => {
        dragging = true;
        sx = e.clientX;
        sy = e.clientY;
        px = panel.offsetLeft;
        py = panel.offsetTop;
        ui.head.classList.add("dragging");
      });
      document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        panel.style.left = `${px + e.clientX - sx}px`;
        panel.style.top = `${py + e.clientY - sy}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      });
      document.addEventListener("mouseup", () => {
        dragging = false;
        ui.head.classList.remove("dragging");
      });
    })();

    send({ type: "register", pageKey: pageKey() }, (resp) => {
      connected = !!(resp && resp.connected);
      setStorageKey(resp && resp.tabId);
      loadState().then(() => {
        if (connected) setStatus("Daemon connected.");
        else setStatus("Not connected. Run shmakk browser-daemon.", true);
      });
    });
  }
})();
