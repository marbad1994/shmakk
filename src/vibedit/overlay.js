// vibedit overlay - injected into every document load via Playwright addInitScript.
// Renders inside a shadow root so the host page styles never bleed in.
(() => {
  if (window.__vibeditLoaded) return;
  window.__vibeditLoaded = true;
  const PORT = window.__VIBEDIT__ && window.__VIBEDIT__.port;
  if (!PORT) return;

  // addInitScript fires before the document has parsed anything, so
  // document.documentElement and document.body may not exist yet.
  function whenDomReady(fn) {
    if (document.readyState === "interactive" || document.readyState === "complete") fn();
    else document.addEventListener("DOMContentLoaded", fn, { once: true });
  }

  whenDomReady(init);

  function init() {
  if (location.href === "about:blank" || !document.body) return;

  const ICONS = {
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/></svg>',
    pointer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    record: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>',
    automate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>'
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
  width: 380px; max-height: min(720px, calc(100vh - 110px));
  display: none; flex-direction: column;
  background: #16181d; color: #e7e9ee; border: 1px solid #2c2f38;
  border-radius: 16px; box-shadow: 0 16px 48px rgba(0,0,0,.5);
}
.panel.open { display: flex; }

.head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #23262e; flex: 0 0 auto; cursor: grab; user-select: none; }
.head.dragging { cursor: grabbing; }
.head .title { font-size: 13px; font-weight: 600; letter-spacing: .04em; color: #e8a33d; }
.head .model { font-size: 11px; color: #8b909d; margin-left: auto; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.head .dot { width: 7px; height: 7px; border-radius: 50%; background: #5a5f6b; }
.head .dot.on { background: #58c789; }

.toolbar { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid #23262e; flex: 0 0 auto; overflow: visible; }
.btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px;
  border-radius: 8px; border: 1px solid #2c2f38; background: #1d2026; color: #cfd3dc;
  font-size: 11.5px; cursor: pointer; transition: background .12s ease, color .12s ease, border-color .12s ease;
}
.btn:hover { background: #262a32; border-color: #3a3e49; }
.btn.active { background: #2c2417; border-color: #6b5523; color: #e8a33d; }
.btn.rec { background: #2c1717; border-color: #6b2323; color: #e25555; }
.btn.automation { background: #1d242c; border-color: #3a5068; color: #5b9bd5; }
.btn.danger { color: #c66; }
.btn.danger:hover { background: #2c1717; border-color: #6b2323; }
.btn svg { width: 13px; height: 13px; flex-shrink: 0; }
.btn.hasChanges { background: #2c2417; border-color: #6b5523; color: #e8a33d; }

.savewrap { position: relative; }
.savedrop { position: absolute; top: 100%; right: 0; margin-top: 6px; width: 320px; max-height: 260px; overflow-y: auto; background: #16181d; border: 1px solid #2c2f38; border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.55); display: none; flex-direction: column; z-index: 2147483647; }
.savedrop.open { display: flex; }
.savedrop .drophead { font-size: 11px; color: #8b909d; padding: 8px 12px 4px; }
.savedrop .droprow { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 11px; color: #cfd3dc; }
.savedrop .droprow + .droprow { border-top: 1px solid #23262e; }
.savedrop .droprow .sel { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, monospace; font-size: 10.5px; color: #8b909d; }
.savedrop .droprow .kind { color: #8b909d; font-size: 10px; text-transform: uppercase; flex-shrink: 0; }
.savedrop .droprow button { all: unset; cursor: pointer; color: #8b909d; display: inline-flex; flex-shrink: 0; }
.savedrop .droprow button:hover { color: #e25555; }
.savedrop .droprow button svg { width: 12px; height: 12px; }
.savedrop .dropact { padding: 8px 12px; border-top: 1px solid #23262e; display: flex; gap: 6px; justify-content: flex-end; }

.msgs { flex: 1 1 auto; min-height: 400px; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; scrollbar-width: thin; scrollbar-color: #2c2f38 transparent; }
.msgs::-webkit-scrollbar { width: 5px; }
.msgs::-webkit-scrollbar-track { background: transparent; }
.msgs::-webkit-scrollbar-thumb { background: #2c2f38; border-radius: 3px; }
.msgs::-webkit-scrollbar-thumb:hover { background: #3a3e49; }
.msg-user { max-width: 92%; padding: 8px 11px; border-radius: 11px; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; align-self: flex-end; background: #2c2417; color: #f1d9ab; border: 1px solid #463a1d; border-left: 3px solid #e8a33d; }
.msg-ai   { max-width: 92%; padding: 8px 11px; border-radius: 11px; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; align-self: flex-start; background: #1d2026; border: 1px solid #2c2f38; border-left: 3px solid #4da6e8; }
.msg-sys  { max-width: 92%; padding: 2px 11px; border-radius: 11px; font-size: 11px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; align-self: center; color: #8b909d; background: none; border-left: none; }
.msg-context { position: relative; border: 1px solid rgba(255,255,255,.3); padding: 10px; color: #e8a33d; padding-right: 28px; }
.msg-context .dismiss { position: absolute; top: 6px; right: 8px; background: none; border: none; color: #6b7280; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
.msg-context .dismiss:hover { color: #e25555; background: rgba(255,255,255,.08); }
.msglabel { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; padding: 1px 5px; border-radius: 4px; margin-right: 4px; display: inline-block; vertical-align: middle; }
.msglabel-user { background: #463a1d; color: #e8a33d; }
.msglabel-ai   { background: #1a2d3d; color: #4da6e8; }
.msglabel-context { background: #1d2620; color: #8bbf6a; }
.msglabel-instruction { background: #1d2a3d; color: #5b9bd5; }
.msg-flow { max-width: 100%; padding: 10px 12px; border-radius: 11px; font-size: 12.5px; line-height: 1.45; white-space: pre-wrap; word-break: break-word; align-self: stretch; background: #1d2026; border: 1px solid #2c2f38; border-left: 3px solid transparent; display: flex; flex-direction: column; gap: 8px; }
.msg-flow img { width: 100%; max-height: 200px; object-fit: contain; border-radius: 9px; border: 1px solid #2c2f38; background: #0f1116; min-height: 60px; }
.msg-flow .scrub { display: flex; align-items: center; gap: 8px; }
.msg-flow input[type=range] { flex: 1; accent-color: #e8a33d; }
.msg-flow .pbtn { background: #1d2026; border: 1px solid #2c2f38; border-radius: 8px; color: #cfd3dc; padding: 5px 8px; cursor: pointer; display: inline-flex; }
.msg-flow .pbtn svg { width: 13px; height: 13px; }
.msg-flow .evt { font-size: 11px; color: #8b909d; min-height: 14px; }

.inspector { border-top: 1px solid #23262e; padding: 10px 12px; display: none; flex-direction: column; gap: 8px; flex: 0 1 auto; min-height: 400px; overflow-y: auto; }
.inspector.open { display: flex; }
.panel.editing #msgs { display: none; }
.panel.editing .inspector.open { flex: 1 1 auto; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 5px; background: #1d2026; border: 1px solid #2c2f38; border-radius: 7px; padding: 3px 7px; font-size: 11px; color: #cfd3dc; cursor: pointer; }
.chip:hover { border-color: #3a3e49; }
.chip.scoped { border-color: #6b5523; color: #e8a33d; }
.chip button { all: unset; cursor: pointer; color: #8b909d; display: inline-flex; }
.chip button:hover { color: #e25555; }
.chip button svg { width: 10px; height: 10px; }
.chipadd { width: 86px; background: #0f1116; border: 1px solid #2c2f38; border-radius: 7px; color: #e7e9ee; font-size: 11px; padding: 4px 7px; outline: none; }
.chipadd:focus { border-color: #6b5523; }
.scopesel { flex: 1; background: #0f1116; border: 1px solid #2c2f38; border-radius: 7px; color: #e7e9ee; font-size: 12px; padding: 5px 8px; outline: none; min-width: 0; }
.props { display: flex; flex-direction: column; gap: 5px; }
.props .prow { display: flex; gap: 6px; }
.props input { background: #0f1116; border: 1px solid #2c2f38; border-radius: 7px; color: #e7e9ee; font-size: 11.5px; padding: 4px 7px; outline: none; min-width: 0; }
.props input.pname { flex: 0 0 42%; }
.props input.pval { flex: 1; }
.props input.pcolor { flex: 0 0 28px; width: 28px; height: 28px; padding: 2px; border-radius: 6px; cursor: pointer; }
.props input:focus { border-color: #6b5523; }
.btn.small { padding: 5px 9px; font-size: 11px; align-self: flex-start; }
.inspector .sel { font-size: 11px; color: #e8a33d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row { display: flex; gap: 8px; align-items: center; }
.row label { font-size: 11px; color: #8b909d; width: 38px; }
.row input[type=color] { width: 30px; height: 24px; border: 1px solid #2c2f38; border-radius: 6px; background: none; padding: 0; cursor: pointer; }
.row input[type=text], .row input[type=number] {
  flex: 1; background: #0f1116; border: 1px solid #2c2f38; border-radius: 7px;
  color: #e7e9ee; font-size: 12px; padding: 5px 8px; outline: none;
}
.row input:focus { border-color: #6b5523; }
.iconbtn { background: none; border: 1px solid #2c2f38; border-radius: 7px; color: #c66; padding: 4px 7px; cursor: pointer; display: inline-flex; }
.iconbtn svg { width: 13px; height: 13px; }

.composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #23262e; flex: 0 0 auto; }
.composer textarea {
  flex: 1; resize: none; height: 54px; background: #0f1116; color: #e7e9ee;
  border: 1px solid #2c2f38; border-radius: 10px; padding: 8px 10px;
  font-size: 12px; outline: none;
}
.composer textarea:focus { border-color: #6b5523; }
.composer textarea.automation { border-color: #3a5068; }
.composer textarea.automation:focus { border-color: #5b9bd5; }
.composer button {
  background: #2c2417; border: 1px solid #6b5523; border-radius: 10px;
  color: #e8a33d; cursor: pointer; padding: 8px 12px; display: inline-flex;
  align-items: center; justify-content: center;
}
.composer button:hover { background: #463a1d; }
.composer button.automation { background: #1d242c; border-color: #3a5068; color: #5b9bd5; }
.composer button.automation:hover { background: #263648; }

.msg-instruction {
  max-width: 92%; padding: 8px 11px; border-radius: 11px; font-size: 12.5px;
  line-height: 1.45; white-space: pre-wrap; word-break: break-word;
  align-self: flex-end;
  background: #1d242c; color: #b8d4f0; border: 1px solid #3a5068;
  border-left: 3px solid #5b9bd5;
}

.automation-banner {
  padding: 6px 12px; background: #1d242c; border-bottom: 1px solid #3a5068;
  color: #5b9bd5; font-size: 11px; font-weight: 600;
  display: none; align-items: center; gap: 8px;
  flex: 0 0 auto;
}
.automation-banner svg { width: 14px; height: 14px; }
.automation-banner .inst-count { color: #8ea4c2; font-weight: 400; margin-left: auto; }
.panel.automation .automation-banner { display: flex; }
.panel.automation .composer { border-top-color: #3a5068; }
  font-size: 12.5px; outline: none;
}
.composer textarea:focus { border-color: #6b5523; }
.composer button {
  width: 42px; border-radius: 10px; border: 1px solid #6b5523; background: #e8a33d;
  color: #16181d; cursor: pointer; display: flex; align-items: center; justify-content: center;
}
.composer button:disabled { opacity: .5; cursor: default; }
.composer button svg { width: 16px; height: 16px; }
.btn.hasShots { background: #2c2617; border-color: #6b5a23; color: #e8b84d; }

.hl { position: fixed; pointer-events: none; z-index: 2147483645; border: 1.5px dashed #e8a33d; border-radius: 3px; display: none; }
.hl.sel { border-style: solid; box-shadow: 0 0 0 3px rgba(232,163,61,.22); }

.shot-preview { padding: 6px; display: flex; flex-direction: column; gap: 5px; }
.shot-preview img { max-height: 200px; object-fit: contain; border-radius: 8px; }
.shot-actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.hl.shot { border: 2px solid #4da6e8; background: rgba(77,166,232,.15); box-shadow: 0 0 0 1px rgba(77,166,232,.3); }
`;

  // ---- shadow host -------------------------------------------------------
  function mount() {
    const host = document.createElement("div");
    host.id = "__vibedit_host";
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    root.appendChild(style);

    root.innerHTML += `
      <div class="puck" id="puck" title="vibedit">${ICONS.spark}</div>
      <div class="panel" id="panel">
        <div class="head">
          <span class="dot" id="dot"></span>
          <span class="title">vibedit</span>
          <span class="model" id="model"></span>
        </div>
        <div class="toolbar">
          <button class="btn" id="editBtn" title="Toggle edit mode">${ICONS.pointer}</button>
          <span class="savewrap"><button class="btn" id="saveBtn" title="Review changes">${ICONS.save}</button>
            <div class="savedrop" id="savedrop"></div></span>
          <button class="btn" id="flowBtn" title="Record userflow">${ICONS.record}</button>
          <button class="btn" id="shotBtn" title="Screenshot area for context">${ICONS.camera}</button>
          <button class="btn" id="automationBtn" title="Automation mode">${ICONS.automate}</button>
        </div>
        <div class="automation-banner" id="automationBanner">${ICONS.automate} Automation mode active<span class="inst-count" id="instCount">0 instructions</span></div>
        <div class="msgs" id="msgs"></div>
        <div class="inspector" id="inspector">
          <div class="sel" id="selPath"></div>
          <div class="chips" id="chips"></div>
          <div class="row">
            <label>Scope</label>
            <select class="scopesel" id="scopeSel"></select>
            <button class="iconbtn" id="delBtn" title="Delete element">${ICONS.trash}</button>
            <button class="iconbtn" id="deselBtn" title="Deselect" style="color:#8b909d">${ICONS.x}</button>
          </div>
          <div class="row" id="textRow"><label>Text</label><input type="text" id="inText"></div>
          <div class="row" id="insertRow">
            <label>Add</label>
            <select class="scopesel" id="insertTag"><option value="p">p</option><option value="div">div</option><option value="span">span</option><option value="button">button</option><option value="h2">h2</option><option value="li">li</option></select>
            <button class="btn small" id="addChild">${ICONS.plus}<span>Inside</span></button>
            <button class="btn small" id="addAfter">${ICONS.plus}<span>After</span></button>
          </div>
          <div class="row">
            <label>Color</label><input type="color" id="inColor">
            <label style="width:auto">Bg</label><input type="color" id="inBg">
            <label style="width:auto">Size</label><input type="number" id="inSize" min="6" max="160" style="width:64px">
          </div>
          <div class="props" id="props"></div>
          <button class="btn small" id="addProp">${ICONS.plus}<span>Add CSS property</span></button>
        </div>
        <div class="composer">
          <textarea id="chatText" placeholder="Ask for a change... e.g. make the header dark blue"></textarea>
          <button id="chatSend">${ICONS.send}</button>
        </div>
      </div>
      <div class="hl" id="hoverHl"></div>
      <div class="hl sel" id="selHl"></div>
      <div class="hl shot" id="shotHl"></div>`;

    return { host, root };
  }

  // ---- state -------------------------------------------------------------
  let ws = null, wsOpen = false;
  let editMode = false;
  let selected = null;
  let screenshotMode = false, justShot = false;
  let shotStartX = 0, shotStartY = 0;
  let recordingFlow = false;
  let automationMode = false;
  let automationInstructions = [];
  let session = null; // { id, base, shots, events }
  let flowMsg = null;  // inline flow message DOM element
  let pendingScreenshots = []; // array of { id, data } — base64 JPEGs waiting to be included in chat
  let screenshotIdCounter = 0;
  let pendingScreenshotMsgs = []; // DOM elements for the preview rows
  const changes = new Map(); // selector -> { selector, before, removed? }

  const { root } = mount();
  const $ = (id) => root.getElementById(id);
  const ui = {
    puck: $("puck"), panel: $("panel"), dot: $("dot"), model: $("model"),
    editBtn: $("editBtn"), saveBtn: $("saveBtn"), savedrop: $("savedrop"), flowBtn: $("flowBtn"),
    msgs: $("msgs"), inspector: $("inspector"), selPath: $("selPath"),
    chips: $("chips"), scopeSel: $("scopeSel"), textRow: $("textRow"), props: $("props"), addProp: $("addProp"),
    insertRow: $("insertRow"), insertTag: $("insertTag"), addChild: $("addChild"), addAfter: $("addAfter"),
    inText: $("inText"), inColor: $("inColor"), inBg: $("inBg"), inSize: $("inSize"),
    delBtn: $("delBtn"), deselBtn: $("deselBtn"),
    chatText: $("chatText"), chatSend: $("chatSend"), shotBtn: $("shotBtn"), automationBtn: $("automationBtn"),
    automationBanner: $("automationBanner"), instCount: $("instCount"),
    hoverHl: $("hoverHl"), selHl: $("selHl"), shotHl: $("shotHl")
  };

  // ---- drag puck ----------------------------------------------------------
  (function makePuckDraggable() {
    let dragging = false, offX = 0, offY = 0;

    function onStart(e) {
      if (ui.panel.classList.contains("open")) return; // don't drag puck when panel is open
      const rect = ui.puck.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      offX = clientX - rect.left;
      offY = clientY - rect.top;
      ui.puck.style.left = rect.left + "px";
      ui.puck.style.top = rect.top + "px";
      ui.puck.style.right = "";
      ui.puck.style.bottom = "";
      dragging = true;
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      ui.puck.style.left = Math.max(0, clientX - offX) + "px";
      ui.puck.style.top = Math.max(0, clientY - offY) + "px";
    }

    function onEnd() { dragging = false; }

    ui.puck.addEventListener("mousedown", onStart);
    ui.puck.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchend", onEnd);
  })();

  // ---- drag panel ---------------------------------------------------------
  (function makePanelDraggable() {
    const head = ui.panel.querySelector(".head");
    let dragging = false, offX = 0, offY = 0;

    function onStart(e) {
      if (e.target.closest && (e.target.closest("button") || e.target.closest("input") || e.target.closest("select"))) return;
      const rect = ui.panel.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      offX = clientX - rect.left;
      offY = clientY - rect.top;
      ui.panel.style.left = rect.left + "px";
      ui.panel.style.top = Math.max(0, rect.top) + "px";
      ui.panel.style.right = "";
      ui.panel.style.bottom = "";
      head.classList.add("dragging");
      dragging = true;
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const maxX = window.innerWidth - ui.panel.offsetWidth;
      const maxY = window.innerHeight - ui.panel.offsetHeight;
      ui.panel.style.left = Math.min(maxX, Math.max(0, clientX - offX)) + "px";
      ui.panel.style.top = Math.min(maxY, Math.max(0, clientY - offY)) + "px";
    }

    function onEnd() {
      if (!dragging) return;
      head.classList.remove("dragging");
      dragging = false;
    }

    head.addEventListener("mousedown", onStart);
    head.addEventListener("touchstart", onStart, { passive: false });
    document.addEventListener("mousemove", onMove);
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("mouseup", onEnd);
    document.addEventListener("touchend", onEnd);
  })();

  // ---- helpers -----------------------------------------------------------
  function isOurs(el) {
    return el && (el.getRootNode() === root || el.id === "__vibedit_host" || el.closest && el.closest("#__vibedit_host"));
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      if (el.id) { parts.unshift(`#${CSS_escape(el.id)}`); break; }
      let part = el.tagName.toLowerCase();
      const cls = [...el.classList].filter((c) => !/^(hover|active|focus)/.test(c)).slice(0, 2);
      if (cls.length) part += "." + cls.map(CSS_escape).join(".");
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === el.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
      }
      parts.unshift(part);
      el = el.parentElement;
    }
    return parts.join(" > ") || "body";
  }
  function CSS_escape(s) { return s.replace(/([^\w-])/g, "\\$1"); }

  function prunedDOM(limit = 9000) {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, svg, #__vibedit_host, link, meta").forEach((n) => n.remove());
    clone.querySelectorAll("*").forEach((n) => {
      [...n.attributes].forEach((a) => {
        if (/^(data-v-|data-react|data-emotion|on)/.test(a.name)) n.removeAttribute(a.name);
        else if (a.value.length > 120) n.setAttribute(a.name, a.value.slice(0, 120) + "...");
      });
    });
    let html = clone.innerHTML.replace(/\n\s*\n/g, "\n").replace(/  +/g, " ");
    return html.slice(0, limit);
  }

  function trackBefore(el) {
    const selector = cssPath(el);
    if (!changes.has(selector)) {
      changes.set(selector, {
        kind: "dom", selector, before: el.outerHTML, beforeText: directText(el), el,
        parent: el.parentNode, next: el.nextSibling
      });
    }
    updateCount();
    return changes.get(selector);
  }

  function markTextChange(el) {
    const rec = trackBefore(el);
    rec.afterText = directText(el);
    rec.after = el.outerHTML;
    updateCount();
    saveLocalStateSoon();
    return rec;
  }

  function setCaretAtEnd(el) {
    try {
      el.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  }

  function updateCount() {
    ui.saveBtn.classList.toggle("hasChanges", changes.size > 0);
    if (!changes.size) ui.savedrop.classList.remove("open");
    saveLocalStateSoon();
  }

  function revertChange(key) {
    const c = changes.get(key);
    if (!c) return;
    if (c.kind === "css") {
      cssRules.delete(c.selector.slice(1)); // strip leading dot
      rebuildStyles();
    } else {
      const wasSelected = selected && (selected === c.el || (c.el && c.el.contains(selected)));
      if (c.removed) {
        const tpl = document.createElement("template");
        tpl.innerHTML = c.before.trim();
        c.parent && c.parent.insertBefore(tpl.content, c.next || null);
      } else if (c.el && c.el.isConnected) {
        c.el.outerHTML = c.before;
      } else {
        const el = document.querySelector(c.selector);
        if (el) el.outerHTML = c.before;
      }
      if (wasSelected) deselect();
    }
    changes.delete(key);
    updateCount();
  }

  function addMsg(kind, text) {
    const div = document.createElement("div");
    div.className = `msg-${kind}`;
    if (kind === "user") {
      div.innerHTML = `<span class="msglabel-user">You</span> ${esc(text)}`;
    } else if (kind === "ai") {
      div.innerHTML = `<span class="msglabel-ai">AI</span> ${esc(text)}`;
    } else if (kind === "instruction") {
      div.innerHTML = `<span class="msglabel-instruction">Instruction</span> ${esc(text)}`;
    } else {
      if (/^Context: /.test(text)) {
        div.classList.add("msg-context");
        div.innerHTML = `<span class="msglabel-context">Context</span> ${esc(text.slice("Context: ".length))}<button class="dismiss" title="Remove context">&times;</button>`;
        div.querySelector(".dismiss").addEventListener("click", () => div.remove());
      } else {
        div.textContent = text;
      }
    }
    ui.msgs.appendChild(div);
    ui.msgs.scrollTop = ui.msgs.scrollHeight;
    return div;
  }
  function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function addScreenshotPreview(id, data) {
    const div = document.createElement("div");
    div.className = "msg-sys shot-preview";
    div.setAttribute("data-shot-id", id);
    div.innerHTML = `<div style="position:relative;display:inline-block;max-width:280px"><img src="data:image/jpeg;base64,${data}" style="width:100%;border-radius:8px;display:block"><button class="btn danger shot-discard" title="Remove screenshot" style="position:absolute;top:4px;right:4px;padding:3px 6px;border-radius:6px;background:rgba(22,24,29,.85)">${ICONS.x}</button></div>`;
    ui.msgs.appendChild(div);
    ui.msgs.scrollTop = ui.msgs.scrollHeight;
    pendingScreenshotMsgs.push(div);
    div.querySelector(".shot-discard").addEventListener("click", () => discardScreenshot(id));
    updateShotCount();
  }

  function discardScreenshot(id) {
    pendingScreenshots = pendingScreenshots.filter((s) => s.id !== id);
    const el = ui.msgs.querySelector(`.shot-preview[data-shot-id="${id}"]`);
    if (el) el.remove();
    pendingScreenshotMsgs = pendingScreenshotMsgs.filter((d) => d.getAttribute("data-shot-id") !== String(id));
    updateShotCount();
    saveLocalStateSoon();
  }

  function clearAllScreenshots() {
    for (const el of pendingScreenshotMsgs) el.remove();
    pendingScreenshots = [];
    pendingScreenshotMsgs = [];
    updateShotCount();
    saveLocalStateSoon();
  }

  function updateShotCount() {
    ui.shotBtn.classList.toggle("hasShots", pendingScreenshots.length > 0);
  }

  // ---- websocket ---------------------------------------------------------
  function connect() {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    ws.onopen = () => {
      wsOpen = true;
      ui.dot.classList.add("on");
      send({ type: "pageStateGet" });
    };
    ws.onclose = () => { wsOpen = false; ui.dot.classList.remove("on"); setTimeout(connect, 1500); };
    ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handleServer(msg);
    };
  }
  function send(obj) { if (wsOpen) ws.send(JSON.stringify(obj)); }

  let stateSaveTimer = null;
  function saveLocalStateSoon() {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = setTimeout(saveLocalState, 120);
  }

  function saveLocalState() {
    if (!wsOpen) return;
    send({
      type: "pageStateSet",
      state: {
        panelOpen: ui.panel.classList.contains("open"),
        automationMode,
        automationInstructions,
        pendingScreenshots: pendingScreenshots.map((s) => ({ id: s.id, size: (s.data || "").length })),
        currentFlowSession: session ? {
          id: session.id,
          base: session.base,
          shots: session.shots,
          events: session.events,
        } : null,
        visualChanges: [...changes.values()].map((c) => ({
          kind: c.kind,
          selector: c.selector,
          before: c.before,
          beforeText: c.beforeText || "",
          after: c.kind === "css" ? (c.after || "") : (c.removed ? "" : (c.el && c.el.isConnected ? c.el.outerHTML : "")),
          afterText: c.afterText || "",
          addedHTML: c.addedHTML || "",
          removed: !!c.removed,
        })),
      },
    });
  }

  function restoreLocalState(saved) {
    if (!saved || typeof saved !== "object") return;
    ui.panel.classList.toggle("open", !!saved.panelOpen);
    if (Array.isArray(saved.automationInstructions)) {
      automationInstructions = saved.automationInstructions.filter((s) => typeof s === "string");
    }
    setAutomationMode(!!saved.automationMode);
    if (saved.currentFlowSession && saved.currentFlowSession.id) {
      session = saved.currentFlowSession;
      showFlowInline();
    }
    if (Array.isArray(saved.visualChanges)) {
      changes.clear();
      for (const c of saved.visualChanges) {
        if (!c || !c.selector) continue;
        let el = null;
        try { el = document.querySelector(c.selector); } catch {}
        changes.set(c.selector, {
          kind: c.kind || "dom",
          selector: c.selector,
          before: c.before || "",
          beforeText: c.beforeText || "",
          after: c.after || "",
          afterText: c.afterText || "",
          addedHTML: c.addedHTML || "",
          removed: !!c.removed,
          el,
          parent: el ? el.parentNode : null,
          next: el ? el.nextSibling : null,
        });
      }
      updateCount();
    }
  }

  function handleServer(msg) {
    if (msg.type === "hello") {
      ui.model.textContent = msg.model + (msg.vision ? " (vision)" : "");
    } else if (msg.type === "pageState") {
      restoreLocalState(msg.state);
    } else if (msg.type === "status") {
      addMsg("sys", msg.text);
    } else if (msg.type === "chatResult") {
      if (msg.reply) addMsg("ai", msg.reply);
      applyOps(msg.ops || []);
    } else if (msg.type === "saveResult") {
      addMsg(msg.ok ? "ai" : "sys", msg.summary + (msg.failed && msg.failed.length ? `\nFailed: ${msg.failed.join(", ")}` : ""));
      if (!msg.ok && msg.modelOutput) addMsg("sys", "Model output (debug): " + msg.modelOutput);
      if (msg.ok) { changes.clear(); updateCount(); saveLocalStateSoon(); }
    } else if (msg.type === "flowStarted") {
      addMsg("sys", "Recording userflow. Click and scroll as usual, then press the button again to stop.");
    } else if (msg.type === "flowStopped") {
      session = msg;
      const evCount = msg.events.filter((e) => e.kind !== "shot").length;
      addMsg("sys", `Recording stopped. ${evCount} interaction${evCount !== 1 ? "s" : ""} captured.`);
      showFlowInline();
      saveLocalStateSoon();
    } else if (msg.type === "automationResult") {
      if (msg.ok) {
        addMsg("ai", `Automation script generated: ${msg.summary}\nSaved to: ${msg.file}`);
        if (msg.notes) addMsg("sys", msg.notes);
        automationInstructions = [];
        updateInstCount();
      } else {
        addMsg("sys", "Automation failed: " + (msg.summary || "parse error"));
        if (msg.modelOutput) addMsg("sys", "Model output (debug): " + msg.modelOutput);
      }
    } else if (msg.type === "error") {
      addMsg("sys", "Error: " + msg.text);
    } else if (msg.type === "screenshotResult") {
      const id = ++screenshotIdCounter;
      pendingScreenshots.push({ id, data: msg.data });
      addScreenshotPreview(id, msg.data);
      saveLocalStateSoon();
    }
  }

  // ---- AI ops on live DOM --------------------------------------------------
  function applyOps(ops) {
    let applied = 0;
    const done = [];
    for (const op of ops) {
      let el;
      try { el = document.querySelector(op.selector); } catch { el = null; }
      if (!el || isOurs(el)) continue;
      const rec = trackBefore(el);
      if (op.action === "setText") { el.textContent = op.value ?? ""; done.push("set text of " + op.selector); }
      else if (op.action === "setHTML") { el.innerHTML = op.value ?? ""; done.push("set HTML of " + op.selector); }
      else if (op.action === "setStyle" && op.style) { for (const [k, v] of Object.entries(op.style)) el.style.setProperty(toKebab(k), v); done.push("styled " + op.selector); }
      else if (op.action === "setAttr") { el.setAttribute(op.name, op.value ?? ""); done.push("set attr " + op.name + " on " + op.selector); }
      else if (op.action === "remove") { rec.removed = true; el.remove(); done.push("removed " + op.selector); }
      else continue;
      applied++;
    }
    if (ops.length && !applied) addMsg("sys", "The model returned selectors that do not exist on this page.");
    else if (applied) addMsg("sys", "Applied: " + done.join(", "));
  }
  function toKebab(s) { return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()); }

  // ---- edit mode -----------------------------------------------------------
  function setEditMode(on) {
    editMode = on;
    ui.editBtn.classList.toggle("active", on);
    ui.editBtn.title = on ? "Edit mode on" : "Edit mode";
    ui.panel.classList.toggle("editing", on);
    if (on) { ui.inspector.classList.add("open"); ui.shotBtn.style.display = "none"; }
    if (!on) { ui.hoverHl.style.display = "none"; deselect(); ui.shotBtn.style.display = ""; }
  }

  function setScreenshotMode(on) {
    screenshotMode = on;
    ui.shotBtn.classList.toggle("active", on);
    if (editMode && on) setEditMode(false);
    if (!on) { ui.shotHl.style.display = "none"; }
    ui.puck.style.display = on ? "none" : ""; // hide puck during drag
  }

  function setAutomationMode(on) {
    automationMode = on;
    ui.automationBtn.classList.toggle("automation", on);
    ui.automationBtn.title = on ? "Automation mode on" : "Automation mode";
    ui.panel.classList.toggle("automation", on);
    ui.chatText.classList.toggle("automation", on);
    ui.chatSend.classList.toggle("automation", on);
    ui.chatText.placeholder = on ? "Describe what to automate... e.g. fill login form and click submit" : "Ask for a change... e.g. make the header dark blue";
    if (on && editMode) setEditMode(false);
    if (on) { updateInstCount(); }
    saveLocalStateSoon();
  }

  function updateInstCount() {
    ui.instCount.textContent = automationInstructions.length + " instruction" + (automationInstructions.length !== 1 ? "s" : "");
  }

  function positionHl(box, el) {
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: r.left - 2 + "px", top: r.top - 2 + "px", width: r.width + 2 + "px", height: r.height + 2 + "px" });
  }

  function select(el) {
    deselect(false);
    selected = el;
    scope = "el";
    trackBefore(el);
    positionHl(ui.selHl, el);
    ui.inspector.classList.add("open");
    ui.selPath.textContent = cssPath(el);
    const cs = getComputedStyle(el);
    ui.inText.value = directText(el);
    ui.inColor.value = rgbToHex(cs.color);
    ui.inBg.value = rgbToHex(cs.backgroundColor);
    ui.inSize.value = parseInt(cs.fontSize, 10) || "";
    refreshInspector();
    el.setAttribute("contenteditable", "true");
    el.setAttribute("spellcheck", "false");
    el.addEventListener("input", onLiveType);
    setCaretAtEnd(el);
    addMsg("sys", "Context: " + cssPath(el));
    send({ type: "context", selected: el.outerHTML.slice(0, 2000), selector: cssPath(el) });
  }

  function deselect(hide = true) {
    if (selected) {
      selected.removeAttribute("contenteditable");
      selected.removeAttribute("spellcheck");
      selected.removeEventListener("input", onLiveType);
    }
    selected = null;
    if (hide) { ui.selHl.style.display = "none"; ui.inspector.classList.remove("open"); }
  }

  function onLiveType() {
    if (!selected) return;
    ui.inText.value = directText(selected);
    markTextChange(selected);
    positionHl(ui.selHl, selected);
  }

  function directText(el) {
    return [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() || el.textContent.trim().slice(0, 200);
  }

  function insertElement(where) {
    if (!selected) return;
    const tag = /^(p|div|span|button|h2|li)$/.test(ui.insertTag.value) ? ui.insertTag.value : "p";
    const parent = where === "inside" ? selected : selected.parentElement;
    if (!parent) return;
    const rec = trackBefore(parent);
    const el = document.createElement(tag);
    el.textContent = "New text";
    el.setAttribute("data-vibedit-added", "true");
    if (where === "inside") selected.appendChild(el);
    else selected.insertAdjacentElement("afterend", el);
    rec.after = parent.outerHTML;
    rec.added = true;
    rec.addedHTML = el.outerHTML;
    rec.afterText = directText(parent);
    updateCount();
    saveLocalStateSoon();
    select(el);
  }

  function rgbToHex(rgb) {
    const m = rgb && rgb.match(/(\d+)[, ]+(\d+)[, ]+(\d+)/);
    if (!m) return "#000000";
    return "#" + [m[1], m[2], m[3]].map((v) => (+v).toString(16).padStart(2, "0")).join("");
  }

  document.addEventListener("mousemove", (e) => {
    if (screenshotMode && shotStartX !== undefined) {
      const x = Math.min(shotStartX, e.clientX);
      const y = Math.min(shotStartY, e.clientY);
      const w = Math.abs(e.clientX - shotStartX);
      const h = Math.abs(e.clientY - shotStartY);
      Object.assign(ui.shotHl.style, { display: "block", left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
      return;
    }
    if (!editMode || isOurs(e.target)) { if (editMode) ui.hoverHl.style.display = "none"; return; }
    positionHl(ui.hoverHl, e.target);
  }, true);

  document.addEventListener("mousedown", (e) => {
    if (!screenshotMode || isOurs(e.target)) return;
    e.preventDefault();
    shotStartX = e.clientX;
    shotStartY = e.clientY;
  }, true);

  document.addEventListener("click", (e) => {
    if (justShot) { justShot = false; return; }
    if (recordingFlow && !isOurs(e.target)) {
      send({ type: "flowEvent", ev: { kind: "click", selector: cssPath(e.target), text: (e.target.textContent || "").trim().slice(0, 80), x: e.clientX, y: e.clientY } });
    }
    if (!editMode || isOurs(e.target)) return;
    if (selected && (e.target === selected || selected.contains(e.target))) {
      positionHl(ui.selHl, selected);
      return;
    }
    e.preventDefault(); e.stopPropagation();
    select(e.target);
  }, true);

  document.addEventListener("mouseup", (e) => {
    if (!screenshotMode || isOurs(e.target) || shotStartX === undefined) return;
    const x1 = Math.min(shotStartX, e.clientX);
    const y1 = Math.min(shotStartY, e.clientY);
    const x2 = Math.max(shotStartX, e.clientX);
    const y2 = Math.max(shotStartY, e.clientY);
    const w = x2 - x1;
    const h = y2 - y1;
    shotStartX = undefined;
    if (w < 5 || h < 5) return; // too small, ignore
    setScreenshotMode(false);
    justShot = true;
    addMsg("sys", "Screenshot capturing...");
    send({ type: "screenshot", x: Math.round(x1), y: Math.round(y1), width: Math.round(w), height: Math.round(h) });
  }, true);

  let scrollT = null;
  document.addEventListener("scroll", () => {
    if (selected) positionHl(ui.selHl, selected);
    if (!recordingFlow) return;
    clearTimeout(scrollT);
    scrollT = setTimeout(() => send({ type: "flowEvent", ev: { kind: "scroll", y: Math.round(window.scrollY) } }), 250);
  }, true);

  document.addEventListener("input", (e) => {
    if (recordingFlow && !isOurs(e.target) && /^(input|textarea|select)$/i.test(e.target.tagName)) {
      send({ type: "flowEvent", ev: { kind: "input", selector: cssPath(e.target) } });
    }
  }, true);

  // ---- CSS value autocomplete map -------------------------------------------
  const CSS_VALUES = {
    display: ["flex", "grid", "block", "inline", "inline-block", "inline-flex", "inline-grid", "none", "contents", "table", "table-row", "table-cell"],
    position: ["static", "relative", "absolute", "fixed", "sticky"],
    "flex-direction": ["row", "column", "row-reverse", "column-reverse"],
    "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
    "align-items": ["stretch", "flex-start", "flex-end", "center", "baseline"],
    "align-self": ["auto", "stretch", "flex-start", "flex-end", "center", "baseline"],
    "align-content": ["stretch", "flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"],
    "justify-content": ["flex-start", "flex-end", "center", "space-between", "space-around", "space-evenly"],
    "justify-items": ["stretch", "start", "end", "center"],
    "justify-self": ["auto", "stretch", "start", "end", "center"],
    "text-align": ["left", "center", "right", "justify", "start", "end"],
    "vertical-align": ["baseline", "top", "middle", "bottom", "text-top", "text-bottom", "sub", "super"],
    "font-weight": ["normal", "bold", "lighter", "bolder", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
    "font-style": ["normal", "italic", "oblique"],
    "text-transform": ["none", "uppercase", "lowercase", "capitalize"],
    "text-decoration": ["none", "underline", "overline", "line-through", "underline overline"],
    "white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
    "overflow": ["visible", "hidden", "scroll", "auto", "clip"],
    "overflow-x": ["visible", "hidden", "scroll", "auto", "clip"],
    "overflow-y": ["visible", "hidden", "scroll", "auto", "clip"],
    "visibility": ["visible", "hidden", "collapse"],
    "cursor": ["default", "pointer", "text", "move", "not-allowed", "grab", "grabbing", "crosshair", "zoom-in", "zoom-out", "help", "wait", "progress", "cell", "col-resize", "row-resize", "ew-resize", "ns-resize", "none"],
    "pointer-events": ["auto", "none"],
    "box-sizing": ["content-box", "border-box"],
    "object-fit": ["fill", "contain", "cover", "none", "scale-down"],
    "object-position": ["top", "center", "bottom", "left", "right", "top left", "top center", "top right", "center left", "center center", "center right", "bottom left", "bottom center", "bottom right"],
    "border-style": ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset", "hidden"],
    "outline-style": ["none", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset"],
    "resize": ["none", "both", "horizontal", "vertical"],
    "user-select": ["auto", "none", "text", "all", "contain"],
    "word-break": ["normal", "break-all", "keep-all", "break-word"],
    "text-overflow": ["clip", "ellipsis"],
    "mix-blend-mode": ["normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion"],
    "background-size": ["auto", "cover", "contain"],
    "background-repeat": ["repeat", "no-repeat", "repeat-x", "repeat-y", "space", "round"],
    "background-attachment": ["scroll", "fixed", "local"],
    "background-position": ["top", "center", "bottom", "left", "right", "top left", "top center", "top right", "center left", "center center", "center right", "bottom left", "bottom center", "bottom right"],
    isolation: ["auto", "isolate"],
    "z-index": ["0", "1", "10", "100", "auto"],
    "border-collapse": ["collapse", "separate"],
    "float": ["none", "left", "right"],
    clear: ["none", "left", "right", "both"],
    "grid-template-columns": ["repeat(auto-fill, minmax(200px, 1fr))", "1fr", "auto"],
    "grid-template-rows": ["auto", "1fr"],
    gap: ["0", "4px", "8px", "12px", "16px", "24px", "1rem"],
    "border-radius": ["0", "4px", "8px", "12px", "16px", "50%", "9999px"],
    opacity: ["0", "0.1", "0.25", "0.5", "0.75", "0.9", "1"],
    "transition-timing-function": ["ease", "linear", "ease-in", "ease-out", "ease-in-out", "step-start", "step-end"],
    transform: ["none"],
    "animation-fill-mode": ["none", "forwards", "backwards", "both"],
    "animation-direction": ["normal", "reverse", "alternate", "alternate-reverse"],
    "animation-timing-function": ["ease", "linear", "ease-in", "ease-out", "ease-in-out"],
  };

  const COLOR_PROPS = new Set([
    "color", "background-color", "border-color", "border-top-color", "border-right-color",
    "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color",
    "caret-color", "accent-color", "column-rule-color", "fill", "stroke",
    "background", "border", "border-top", "border-right", "border-bottom", "border-left",
    "outline", "column-rule", "box-shadow", "text-shadow",
  ]);

  function isColorProp(prop) { return COLOR_PROPS.has(prop); }

  function isColorValue(val) {
    if (!val) return false;
    return /^\s*#([0-9a-fA-F]{3,8})\s*$/.test(val) ||
           /^\s*rgb\s*\(/.test(val) ||
           /^\s*hsl\s*\(/.test(val) ||
           /^\s*rgba\s*\(/.test(val) ||
           /^\s*hsla\s*\(/.test(val) ||
           /^\s*(transparent|currentColor|inherit|initial|unset)\s*$/.test(val) ||
           /^\s*(red|blue|green|white|black|yellow|orange|purple|pink|brown|gray|grey|cyan|magenta|maroon|navy|teal|olive|silver|gold|coral|salmon|turquoise|violet|indigo|crimson|tomato|chocolate|beige|ivory|lavender|wheat|khaki|tan|plum|orchid|azure|mint|aqua|lime|rose|peach|skyblue|cornflowerblue|royalblue|steelblue|darkblue|darkgreen|darkred|darkorange|lightblue|lightgreen|lightgray|lightgrey|darkgray|darkgrey|dimgray|dimgrey|whitesmoke)\s*$/.test(val);
  }

  function parseColor(val) {
    if (!val) return null;
    val = val.trim();
    if (/^#([0-9a-fA-F]{3,8})$/.test(val)) return val.length === 4 ? val.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : val.padEnd(7, "0");
    // map common named colors to hex
    const named = { red:"#ff0000", blue:"#0000ff", green:"#008000", white:"#ffffff", black:"#000000", yellow:"#ffff00", orange:"#ffa500", purple:"#800080", pink:"#ffc0cb", brown:"#a52a2a", gray:"#808080", grey:"#808080", cyan:"#00ffff", magenta:"#ff00ff", maroon:"#800000", navy:"#000080", teal:"#008080", olive:"#808000", silver:"#c0c0c0", gold:"#ffd700", coral:"#ff7f50", salmon:"#fa8072", turquoise:"#40e0d0", violet:"#ee82ee", indigo:"#4b0082", crimson:"#dc143c", tomato:"#ff6347", beige:"#f5f5dc", ivory:"#fffff0", lavender:"#e6e6fa", wheat:"#f5deb3", khaki:"#f0e68c", tan:"#d2b48c", plum:"#dda0dd", orchid:"#da70d6", azure:"#f0ffff", mint:"#f5fffa", aqua:"#00ffff", lime:"#00ff00", skyblue:"#87ceeb", lightblue:"#add8e6", lightgreen:"#90ee90", lightgray:"#d3d3d3", darkgray:"#a9a9a9", transparent:"#000000", currentColor:"#000000", };
    if (named[val.toLowerCase()]) return named[val.toLowerCase()];
    // try to extract from rgb/hsl
    const m = val.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) { return "#" + m.slice(1,4).map(n => parseInt(n).toString(16).padStart(2,"0")).join(""); }
    return null;
  }

  function suggestValues(prop) {
    const exact = CSS_VALUES[prop];
    if (exact) return exact;
    // try shorthand/longhand matching
    for (const [k, v] of Object.entries(CSS_VALUES)) {
      if (k.includes(prop) || prop.includes(k)) return v;
    }
    return [];
  }

  function numericCssValue(value) {
    const m = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)([a-z%]*)$/i);
    if (!m) return null;
    return { n: Number(m[1]), unit: m[2] || "" };
  }

  function stepCssValue(value, direction, event) {
    const parsed = numericCssValue(value);
    if (!parsed || Number.isNaN(parsed.n)) return null;
    const step = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
    const next = parsed.n + direction * step;
    const fixed = Math.abs(step) < 1 ? Number(next.toFixed(2)) : next;
    return `${fixed}${parsed.unit}`;
  }

  // scope is "el" (inline styles on the selected element) or a class name
  // (edits a .class rule applied to every element with that class).
  let scope = "el";
  const cssRules = new Map(); // class -> Map(prop -> value)
  let styleEl = null;

  function ensureStyleEl() {
    if (!styleEl || !styleEl.isConnected) {
      styleEl = document.createElement("style");
      styleEl.id = "__vibedit_style";
      document.head.appendChild(styleEl);
    }
    return styleEl;
  }
  function rebuildStyles() {
    ensureStyleEl().textContent = [...cssRules.entries()]
      .filter(([, m]) => m.size)
      .map(([cls, m]) => `.${CSS_escape(cls)} { ${[...m.entries()].map(([p, v]) => `${p}: ${v} !important`).join("; ")} }`)
      .join("\n");
  }
  function serializeRule(cls) {
    const m = cssRules.get(cls) || new Map();
    return `.${cls} {\n${[...m.entries()].map(([p, v]) => `  ${p}: ${v};`).join("\n")}\n}`;
  }
  function existingRuleText(cls) {
    const out = [];
    const re = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
    const visit = (rule) => {
      if (rule.selectorText && re.test(rule.selectorText)) out.push(rule.cssText);
      if (rule.cssRules && rule.cssRules.length) for (const r of rule.cssRules) visit(r);
    };
    for (const sheet of document.styleSheets) {
      if (sheet.ownerNode && sheet.ownerNode.id === "__vibedit_style") continue;
      let rules; try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      for (const r of rules || []) visit(r);
    }
    return out.join("\n");
  }
  function existingDecls(cls) {
    const m = new Map();
    for (const block of existingRuleText(cls).matchAll(/\{([^}]*)\}/g)) {
      for (const decl of block[1].split(";")) {
        const i = decl.indexOf(":");
        if (i > 0) m.set(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
      }
    }
    return m;
  }
  function trackCss(cls) {
    const key = "css:" + cls;
    if (!changes.has(key)) {
      changes.set(key, { kind: "css", selector: "." + cls, before: existingRuleText(cls) || "(no existing rule)" });
    }
    changes.get(key).after = serializeRule(cls);
    updateCount();
  }
  function setProp(prop, value) {
    prop = prop.trim();
    if (!prop) return;
    if (scope === "el") {
      if (!selected) return;
      trackBefore(selected);
      if (value === "") selected.style.removeProperty(prop);
      else selected.style.setProperty(prop, value);
    } else {
      if (!cssRules.has(scope)) cssRules.set(scope, new Map());
      const m = cssRules.get(scope);
      if (value === "") {
        // removing a declaration that exists in the project CSS needs an override
        if (existingDecls(scope).has(prop)) m.set(prop, "unset");
        else m.delete(prop);
      } else m.set(prop, value);
      rebuildStyles();
      trackCss(scope);
    }
  }
  function propsForScope() {
    if (scope === "el") {
      const m = new Map();
      if (selected) for (let i = 0; i < selected.style.length; i++) {
        const p = selected.style[i];
        m.set(p, selected.style.getPropertyValue(p));
      }
      return m;
    }
    const m = existingDecls(scope);
    const ov = cssRules.get(scope);
    if (ov) for (const [p, v] of ov) m.set(p, v);
    return m;
  }
  const COMMON_CSS = [
    "color", "background", "background-color", "background-image", "background-size",
    "border", "border-radius", "border-color", "border-width", "border-style",
    "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
    "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
    "width", "max-width", "min-width", "height", "max-height", "min-height",
    "display", "position", "top", "right", "bottom", "left", "z-index",
    "flex", "flex-direction", "flex-wrap", "flex-grow", "flex-shrink", "flex-basis",
    "align-items", "justify-content", "align-self", "justify-self", "gap",
    "grid", "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
    "font-family", "font-size", "font-weight", "font-style", "line-height",
    "text-align", "text-decoration", "text-transform", "letter-spacing", "word-spacing",
    "opacity", "visibility", "overflow", "overflow-x", "overflow-y",
    "box-shadow", "text-shadow", "filter", "backdrop-filter",
    "transform", "transition", "animation", "cursor", "pointer-events",
    "white-space", "word-break", "text-overflow", "object-fit", "object-position",
    "outline", "outline-color", "outline-width", "outline-style", "outline-offset",
    "box-sizing", "aspect-ratio", "user-select", "scroll-behavior",
    "list-style", "content", "clip-path", "mask", "mask-image",
    "inset", "inset-block", "inset-inline", "place-items", "place-content",
    "accent-color", "caret-color", "scrollbar-width", "scrollbar-color",
    "writing-mode", "direction", "unicode-bidi", "text-orientation",
    "mix-blend-mode", "isolation", "backface-visibility", "perspective",
    "will-change", "contain", "container-type", "container-name",
    "font-variant", "font-stretch", "font-optical-sizing",
    "tab-size", "hyphens", "overflow-wrap", "line-clamp",
    "rotate", "scale", "translate", "offset", "offset-path", "offset-distance",
    "resize", "touch-action", "overscroll-behavior", "scroll-snap-type", "scroll-snap-align",
    "shape-outside", "shape-margin", "image-rendering", "color-scheme",
    "columns", "column-gap", "row-gap", "order", "flex-flow",
    "align-content", "justify-items", "justify-self",
    "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
    "grid-template-areas", "grid-area", "grid-column-start", "grid-column-end",
    "grid-row-start", "grid-row-end",
    "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
    "border-top", "border-right", "border-bottom", "border-left",
  ];

  function addPropRow(p = "", v = "") {
    const row = document.createElement("div");
    row.className = "prow";
    row.innerHTML = `<input class="pname" placeholder="property"><input class="pval" placeholder="value"><input type="color" class="pcolor" title="Color picker"><button class="iconbtn" title="Remove">${ICONS.x}</button>`;
    const [pn, pv, pc] = row.querySelectorAll("input");
    pn.value = p; pv.value = v;

    const commit = () => { if (pn.value.trim() && pv.value.trim()) setProp(pn.value, pv.value); };

    // --- color picker integration ---
    pc.style.display = "none";
    const syncColorPicker = () => {
      const prop = pn.value.trim();
      const val = pv.value.trim();
      if (isColorProp(prop) || isColorValue(val)) {
        pc.style.display = "";
        const c = parseColor(val);
        if (c && pc.value !== c) pc.value = c;
      } else {
        pc.style.display = "none";
      }
    };
    pc.addEventListener("input", () => {
      pv.value = pc.value;
      commit();
    });

    // --- wired autocomplete (arrow keys + tab/enter to select) ---
    function wireAutocomplete(input, getSuggestions) {
      let idx = -1;
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (input === pv && numericCssValue(input.value)) {
            e.preventDefault();
            const next = stepCssValue(input.value, e.key === "ArrowUp" ? 1 : -1, e);
            if (next != null) {
              input.value = next;
              syncColorPicker();
              commit();
            }
            return;
          }
          e.preventDefault();
          const sug = getSuggestions();
          if (!sug.length) { idx = -1; return; }
          if (idx === -1) idx = e.key === "ArrowDown" ? -1 : sug.length;
          idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + sug.length) % sug.length;
          input.value = sug[idx];
        } else if (e.key === "Tab" || e.key === "Enter") {
          if (idx >= 0) {
            e.preventDefault();
            const sug = getSuggestions();
            if (sug[idx]) input.value = sug[idx];
            idx = -1;
          }
          if (e.key === "Enter") commit();
        } else {
          idx = -1;
        }
      });
    }

    wireAutocomplete(pn, () => {
      const v = pn.value.trim().toLowerCase();
      return v ? COMMON_CSS.filter((s) => s.startsWith(v)).slice(0, 20) : COMMON_CSS.slice(0, 20);
    });

    wireAutocomplete(pv, () => suggestValues(pn.value.trim()));

    // --- wire events ---
    pn.addEventListener("change", commit);
    pn.addEventListener("input", () => { syncColorPicker(); if (pv.value.trim()) commit(); });
    pv.addEventListener("change", commit);
    pv.addEventListener("input", () => { syncColorPicker(); commit(); });
    row.querySelector("button").addEventListener("click", () => {
      if (pn.value.trim()) setProp(pn.value, "");
      row.remove();
    });
    ui.props.appendChild(row);
    if (p) { syncColorPicker(); }
    if (!p) pn.focus();
  }
  function renderProps() {
    ui.props.innerHTML = "";
    for (const [p, v] of propsForScope()) addPropRow(p, v);
  }
  function renderChips() {
    ui.chips.innerHTML = "";
    if (!selected) return;
    for (const cls of [...selected.classList]) {
      const chip = document.createElement("span");
      chip.className = "chip" + (scope === cls ? " scoped" : "");
      chip.innerHTML = `<span>.${cls}</span><button title="Remove class from element">${ICONS.x}</button>`;
      chip.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        trackBefore(selected);
        selected.classList.remove(cls);
        if (scope === cls) scope = "el";
        refreshInspector();
      });
      chip.addEventListener("click", () => { scope = cls; refreshInspector(); });
      ui.chips.appendChild(chip);
    }
    const add = document.createElement("input");
    add.className = "chipadd";
    add.placeholder = "add class";
    add.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && add.value.trim()) {
        trackBefore(selected);
        selected.classList.add(add.value.trim().replace(/^\./, ""));
        refreshInspector();
      }
    });
    ui.chips.appendChild(add);
  }
  function renderScope() {
    ui.scopeSel.innerHTML = "";
    const optEl = document.createElement("option");
    optEl.value = "el";
    optEl.textContent = "This element only";
    ui.scopeSel.appendChild(optEl);
    if (selected) for (const cls of selected.classList) {
      const o = document.createElement("option");
      o.value = cls;
      o.textContent = `.${cls} (every element with this class)`;
      ui.scopeSel.appendChild(o);
    }
    ui.scopeSel.value = scope !== "el" && selected && selected.classList.contains(scope) ? scope : "el";
    if (ui.scopeSel.value === "el") scope = "el";
  }
  function refreshInspector() {
    renderChips();
    renderScope();
    renderProps();
    ui.textRow.style.display = scope === "el" ? "flex" : "none";
  }

  // ---- inspector wiring ------------------------------------------------------
  ui.scopeSel.addEventListener("change", () => { scope = ui.scopeSel.value; refreshInspector(); });
  ui.addProp.addEventListener("click", () => addPropRow());
  ui.addChild.addEventListener("click", () => insertElement("inside"));
  ui.addAfter.addEventListener("click", () => insertElement("after"));
  ui.inText.addEventListener("input", () => {
    if (!selected) return;
    trackBefore(selected);
    const tn = [...selected.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
    if (tn) tn.textContent = ui.inText.value;
    else if (selected.children.length === 0) selected.textContent = ui.inText.value;
    markTextChange(selected);
    positionHl(ui.selHl, selected);
  });
  ui.inColor.addEventListener("input", () => { setProp("color", ui.inColor.value); renderProps(); });
  ui.inBg.addEventListener("input", () => { setProp("background-color", ui.inBg.value); renderProps(); });
  ui.inSize.addEventListener("input", () => { if (ui.inSize.value) { setProp("font-size", ui.inSize.value + "px"); renderProps(); } });
  ui.delBtn.addEventListener("click", () => {
    if (!selected) return;
    const rec = changes.get(cssPath(selected)) || trackBefore(selected);
    rec.removed = true;
    selected.remove();
    deselect();
  });
  ui.deselBtn.addEventListener("click", () => deselect());

  // ---- toolbar ----------------------------------------------------------------
  ui.puck.addEventListener("click", () => {
    ui.panel.classList.toggle("open");
    saveLocalStateSoon();
  });
  ui.editBtn.addEventListener("click", () => setEditMode(!editMode));
  ui.shotBtn.addEventListener("click", () => setScreenshotMode(!screenshotMode));

  function renderSaveDrop() {
    const entries = [...changes];
    if (!entries.length) { ui.savedrop.classList.remove("open"); return; }
    const domCount = entries.filter(([,c]) => c.kind !== "css").length;
    const cssCount = entries.filter(([,c]) => c.kind === "css").length;
    let html = `<div class="drophead">${entries.length} change${entries.length !== 1 ? "s" : ""} — ${domCount} element${domCount !== 1 ? "s" : ""}, ${cssCount} CSS rule${cssCount !== 1 ? "s" : ""}</div>`;
    for (const [key, c] of entries) {
      const sel = c.kind === "css" ? c.selector : `…${c.selector.slice(-50)}`;
      html += `<div class="droprow"><span class="kind">${c.kind === "css" ? "CSS" : "DOM"}</span><span class="sel" title="${c.selector}">${sel}</span><button data-discard="${key}" title="Discard this change">${ICONS.trash}</button></div>`;
    }
    html += `<div class="dropact"><button class="btn danger" id="dropDiscardAll" title="Discard all">${ICONS.trash} Discard all</button><button class="btn active" id="dropSave">${ICONS.save} Save to source</button></div>`;
    ui.savedrop.innerHTML = html;

    // Discard single
    ui.savedrop.querySelectorAll("[data-discard]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        revertChange(btn.dataset.discard);
        if (!changes.size) { ui.savedrop.classList.remove("open"); document.removeEventListener("click", onClickOutside, true); }
        else renderSaveDrop();
      });
    });
    // Discard all
    ui.savedrop.querySelector("#dropDiscardAll").addEventListener("click", () => {
      for (const key of [...changes.keys()]) revertChange(key);
      ui.savedrop.classList.remove("open");
      document.removeEventListener("click", onClickOutside, true);
    });
    // Save
    ui.savedrop.querySelector("#dropSave").addEventListener("click", () => {
      doSave();
    });
  }

  function doSave() {
    deselect();
    const list = [...changes.values()].map((c) => c.kind === "css"
      ? { kind: "css", selector: c.selector, before: c.before, after: c.after || "" }
      : {
          kind: "dom",
          selector: c.selector,
          before: c.before,
          after: c.removed ? "" : (c.after || (c.el && c.el.isConnected ? c.el.outerHTML : "")),
          beforeText: c.beforeText || "",
          afterText: c.afterText || "",
          addedHTML: c.addedHTML || "",
          added: !!c.added,
        }
    ).filter((c) => c.after !== c.before && !(c.kind === "css" && !c.after));
    if (!list.length) { addMsg("sys", "All changes were reverted, nothing to save."); changes.clear(); updateCount(); saveLocalStateSoon(); return; }
    addMsg("user", `Save ${list.length} change(s) to source`);
    send({ type: "save", changes: list, url: location.href, dom: prunedDOM(6000) });
    ui.savedrop.classList.remove("open");
    document.removeEventListener("click", onClickOutside, true);
  }

  function onClickOutside(e) {
    if (!ui.savedrop.contains(e.target) && e.target !== ui.saveBtn) {
      ui.savedrop.classList.remove("open");
      document.removeEventListener("click", onClickOutside, true);
    }
  }

  ui.saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!changes.size) { addMsg("sys", "Nothing to save yet."); return; }
    if (ui.savedrop.classList.contains("open")) { ui.savedrop.classList.remove("open"); document.removeEventListener("click", onClickOutside, true); return; }
    renderSaveDrop();
    ui.savedrop.classList.add("open");
    document.addEventListener("click", onClickOutside, true);
  });

  ui.flowBtn.addEventListener("click", () => {
    recordingFlow = !recordingFlow;
    ui.flowBtn.classList.toggle("rec", recordingFlow);
    ui.flowBtn.innerHTML = recordingFlow ? ICONS.stop : ICONS.record;
    ui.flowBtn.title = recordingFlow ? "Stop recording" : "Record userflow";
    ui.puck.classList.toggle("rec", recordingFlow);
    if (recordingFlow) { send({ type: "flowStart" }); }
    else send({ type: "flowStop" });
  });

  ui.automationBtn.addEventListener("click", () => {
    setAutomationMode(!automationMode);
    if (!automationMode) {
      // On disable: optionally send accumulated instructions
      automationInstructions = [];
      updateInstCount();
    }
  });

  // ---- chat ---------------------------------------------------------------------
  function sendChat() {
    const text = ui.chatText.value.trim();
    if (!text) return;
    ui.chatText.value = "";
    const payload = {
      text,
      url: location.href, title: document.title,
      dom: prunedDOM(), selected: selected ? selected.outerHTML : null
    };

    if (automationMode) {
      // Automation mode: accumulate instructions locally, optionally send with flow
      automationInstructions.push(text);
      updateInstCount();
      addMsg("instruction", text);
      payload.type = "automation";
      payload.instructions = automationInstructions;
      saveLocalStateSoon();
    } else {
      addMsg("user", text);
      payload.type = "chat";
    }

    if (session) { payload.flowEvents = session.events; payload.flowId = session.id; session = null; removeFlowMsg(); saveLocalStateSoon(); }
    if (pendingScreenshots.length) { payload.screenshots = pendingScreenshots.map((s) => s.data); clearAllScreenshots(); }
    send(payload);
  }
  ui.chatSend.addEventListener("click", sendChat);
  ui.chatText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && screenshotMode) { setScreenshotMode(false); shotStartX = undefined; }
  }, true);

  // ---- playback --------------------------------------------------------------------
  function showFlowInline() {
    if (!session) return;
    removeFlowMsg();
    flowMsg = document.createElement("div");
    flowMsg.className = "msg-flow";
    flowMsg.innerHTML =
      `<img id="flowFrame" alt="Frame"><div class="scrub">` +
      `<button class="pbtn" id="flowPlay">${ICONS.play}</button>` +
      `<input type="range" id="flowScrub" min="0" max="${Math.max(0, session.shots - 1)}" value="0">` +
      `<span class="evt" id="flowFrameNo">1/${session.shots}</span></div>` +
      `<div class="evt" id="flowEvtLine"></div>` +
      `<div style="display:flex;justify-content:space-between;align-items:center">` +
      `<span style="font-size:11px;color:#8b909d">${session.events.filter((e) => e.kind !== "shot").length} interactions recorded</span>` +
      `<button class="btn danger" id="flowDiscard" title="Discard recording">${ICONS.trash}</button></div>`;
    ui.msgs.appendChild(flowMsg);
    ui.msgs.scrollTop = ui.msgs.scrollHeight;

    const frame = flowMsg.querySelector("#flowFrame");
    const scrub = flowMsg.querySelector("#flowScrub");
    const frameNo = flowMsg.querySelector("#flowFrameNo");
    const evtLine = flowMsg.querySelector("#flowEvtLine");
    const playBtn = flowMsg.querySelector("#flowPlay");
    const discard = flowMsg.querySelector("#flowDiscard");
    let playTimer = null;

    function showFrame(n) {
      frame.src = `${session.base}shot-${n}.jpg`;
      frameNo.textContent = `${n + 1}/${session.shots}`;
      const shot = session.events.find((e) => e.kind === "shot" && e.n === n);
      if (shot) {
        const near = session.events
          .filter((e) => e.kind !== "shot" && Math.abs(e.t - shot.t) < 1600)
          .map((e) => e.kind === "click" ? `click "${(e.text || e.selector || "").slice(0, 40)}"` : e.kind)
          .join(", ");
        evtLine.textContent = near || " ";
      }
    }
    showFrame(0);

    scrub.addEventListener("input", () => showFrame(+scrub.value));
    playBtn.addEventListener("click", () => {
      if (playTimer) { clearInterval(playTimer); playTimer = null; playBtn.innerHTML = ICONS.play; return; }
      playBtn.innerHTML = ICONS.stop;
      playTimer = setInterval(() => {
        let n = +scrub.value + 1;
        if (n >= session.shots) { clearInterval(playTimer); playTimer = null; playBtn.innerHTML = ICONS.play; return; }
        scrub.value = String(n);
        showFrame(n);
      }, 700);
    });

    discard.addEventListener("click", () => {
      if (!session) return;
      if (playTimer) clearInterval(playTimer);
      send({ type: "flowDiscard", id: session.id });
      session = null;
      removeFlowMsg();
      addMsg("sys", "Recording discarded.");
      saveLocalStateSoon();
    });
  }

  function removeFlowMsg() {
    if (flowMsg) { flowMsg.remove(); flowMsg = null; }
  }

  // keep highlights aligned on resize
  window.addEventListener("resize", () => { if (selected) positionHl(ui.selHl, selected); });
  window.addEventListener("beforeunload", saveLocalState);

  connect();
  addMsg("sys", "Connected page. Toggle Edit mode to click elements, or just ask in chat.");
  } // init
})();
