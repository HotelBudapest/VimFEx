import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
// =========================
// Backend API endpoints
// =========================
const API_LIST = "/api/list";
const API_FILE = "/api/file";
const API_SEARCH = "/api/search";
// Client "root" path - your backend can interpret "/" however you want
const DEFAULT_PATH = "/";

// =========================
// State (editor-like)
// =========================
const state = {
  mode: "normal",   // "normal" | "command" | "search"
  cmd: "",
  cmdErr: "",
  search: "",
  searchErr: "",

  nextId: 1,
  focusId: null,
  root: null,
  windows: new Map(),
};

// Window object shape:
// {
//   id: number,
//   kind: "empty" | "explorer" | "viewer",
//   title: string,
//   explorer?: { cwd, items, cursor, loading, err },
//   viewer?: { path, contentType, objectUrl, text }
// }

// Split tree node:
// - Leaf: { type:"leaf", winId:number }
// - Split: { type:"split", dir:"v"|"h", a:node, b:node }

// =========================
// Utility helpers
// =========================
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, ch => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[ch]));
}

function joinPath(base, name){
  if (!base || base === "/") return "/" + name;
  if (base.endsWith("/")) return base + name;
  return base + "/" + name;
}

function parentPath(p){
  if (!p || p === "/") return "/";
  const trimmed = p.endsWith("/") ? p.slice(0, -1) : p;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return "/";
  return trimmed.slice(0, idx);
}

function getFocusedWin(){
  return state.windows.get(state.focusId) || null;
}

function setMode(mode){
  state.mode = mode;
  document.getElementById("modePill").textContent = mode.toUpperCase();

  if (mode === "command"){
    setPrompt(":");
    showCmdline();
  } else if (mode === "search"){
    setPrompt("/");
    showCmdline();
  } else {
    hideCmdline();
  }
}

function showCmdline(){
  const el = document.getElementById("cmdline");
  el.classList.remove("hidden");
  updateCmdline();
}

function hideCmdline(){
  const el = document.getElementById("cmdline");
  el.classList.add("hidden");
  state.cmdErr = "";
  updateCmdline();
}

function updateCmdline(){
  document.getElementById("cmdtext").textContent =
    state.mode === "search" ? state.search : state.cmd;
  document.getElementById("cmderr").textContent =
    state.mode === "search" ? state.searchErr : (state.cmdErr || "");
}

function setGlobalHint(text){
  document.getElementById("globalHint").textContent = text || "";
}

// =========================
// Tree operations
// =========================
function makeWindow(kind){
  const id = state.nextId++;
  const w = { id, kind, title: "" };

  if (kind === "empty"){
    w.title = "No buffer";
  } else if (kind === "explorer"){
    w.title = "Explorer";
    w.explorer = { cwd: DEFAULT_PATH, items: [], cursor: 0, loading: false, err: "" };
  } else if (kind === "viewer"){
    w.title = "Viewer";
    w.viewer = { path: "", contentType: "", objectUrl: null, text: "" };
  }

  state.windows.set(id, w);
  if (state.focusId == null) state.focusId = id;
  return w;
}

function makeLeaf(winId){
  return { type:"leaf", winId };
}

function makeSplit(dir, a, b){
  return { type:"split", dir, a, b, wA: 1, wB: 1 };
}

function findLeafPath(node, targetWinId, path = []){
  // returns array of nodes along path; last element is the leaf node itself
  if (!node) return null;
  if (node.type === "leaf"){
    return node.winId === targetWinId ? [...path, node] : null;
  }
  const left = findLeafPath(node.a, targetWinId, [...path, node]);
  if (left) return left;
  return findLeafPath(node.b, targetWinId, [...path, node]);
}

function clampWeight(x){
  // keep panes from collapsing too much
  return Math.max(0.25, Math.min(8, x));
}

function scrollFocusedViewer(deltaLines){
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return false;

  const pane = document.querySelector(`[data-win="${w.id}"]`);
  if (!pane) return false;

  const content = pane.querySelector(".content");
  if (!content) return false;

  const px = deltaLines * 48;
  content.scrollBy({ top: px, behavior: "auto" });
  return true;
}

function scrollFocusedViewerXY(dx, dy){
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return false;

  const pane = document.querySelector(`[data-win="${w.id}"]`);
  if (!pane) return false;

  const content = pane.querySelector(".content");
  if (!content) return false;

  content.scrollBy({ left: dx, top: dy, behavior: "auto" });
  return true;
}

function resizeFocused(dir, delta){
  const focusedId = state.focusId;
  if (!focusedId) return;

  const path = findLeafPath(state.root, focusedId);
  if (!path) return;

  // Walk upward from leaf to root to find nearest split of the right direction
  // path looks like: [split, split, ..., leaf]
  for (let i = path.length - 2; i >= 0; i--){
    const node = path[i];
    if (node.type !== "split") continue;
    if (node.dir !== dir) continue;

    const child = path[i + 1]; // this is the subtree we came from (either node.a or node.b)
    const focusedIsA = (node.a === child);

    // If focused pane should "grow", increase its weight, decrease sibling (or vice versa)
    if (focusedIsA){
      node.wA = clampWeight((node.wA ?? 1) + delta);
      node.wB = clampWeight((node.wB ?? 1) - delta);
    } else {
      node.wB = clampWeight((node.wB ?? 1) + delta);
      node.wA = clampWeight((node.wA ?? 1) - delta);
    }

    render();
    return;
  }

  setGlobalHint(`No ${dir === "v" ? "vertical" : "horizontal"} split to resize near focused window.`);
}

function splitFocused(dir){
  const focusedId = state.focusId;
  if (!focusedId) return;

  const newWin = makeWindow("empty");
  const root = state.root;
  const leafPath = findLeafPath(root, focusedId);
  if (!leafPath) return;

  const leaf = leafPath[leafPath.length - 1];
  // Replace that leaf with a split node: existing on a, new on b
  const newNode = makeSplit(dir, makeLeaf(leaf.winId), makeLeaf(newWin.id));

  // Patch into tree
  if (leafPath.length === 1){
    state.root = newNode;
  } else {
    const parent = leafPath[leafPath.length - 2];
    // parent is split
    if (parent.a === leaf) parent.a = newNode;
    else parent.b = newNode;
  }

  // Focus stays on original, like vim (you can change if you want)
  state.focusId = focusedId;
  render();
  setGlobalHint(`${dir === "v" ? "Vertical" : "Horizontal"} split created (new window ${newWin.id}).`);
}

function collectLeafIds(node, out = []){
  if (!node) return out;
  if (node.type === "leaf"){ out.push(node.winId); return out; }
  collectLeafIds(node.a, out);
  collectLeafIds(node.b, out);
  return out;
}

function removeFocusedWindow(){
  const focusedId = state.focusId;
  if (!focusedId) return;

  // Don't remove the last remaining window
  const leafIds = collectLeafIds(state.root);
  if (leafIds.length <= 1){
    setGlobalHint("Cannot close the last window.");
    return;
  }

  // Find path to leaf
  const leafPath = findLeafPath(state.root, focusedId);
  if (!leafPath || leafPath.length < 2){
    setGlobalHint("Internal: couldn't find window in tree.");
    return;
  }

  const leaf = leafPath[leafPath.length - 1];
  const parent = leafPath[leafPath.length - 2]; // split node
  const sibling = (parent.a === leaf) ? parent.b : parent.a;

  // Replace parent with sibling in grandparent
  if (leafPath.length === 2){
    // parent is root
    state.root = sibling;
  } else {
    const grand = leafPath[leafPath.length - 3];
    if (grand.a === parent) grand.a = sibling;
    else grand.b = sibling;
  }

  // Cleanup resources (blob URLs)
  const w = state.windows.get(focusedId);
  if (w?.kind === "viewer" && w.viewer?.objectUrl){
    URL.revokeObjectURL(w.viewer.objectUrl);
  }

  state.windows.delete(focusedId);

  // Choose a new focus: first leaf id
  const newLeafIds = collectLeafIds(state.root);
  state.focusId = newLeafIds[0] || null;

  render();
  setGlobalHint(`Closed window ${focusedId}.`);
}

function focusWindow(id){
  if (!state.windows.has(id)) return;

  const prev = state.focusId;
  state.focusId = id;

  // update focused CSS class
  if (prev != null) {
    const prevPane = document.querySelector(`[data-win="${prev}"]`);
    if (prevPane) prevPane.classList.remove("focused");
  }
  const newPane = document.querySelector(`[data-win="${id}"]`);
  if (newPane) newPane.classList.add("focused");

  // update "FOCUS" label in statusline
  document.querySelectorAll(".statusRight span").forEach(span => {
    span.textContent = "";
  });
  if (newPane) {
    const focusSpan = newPane.querySelector(".statusRight span");
    if (focusSpan) focusSpan.textContent = "FOCUS";
  }

  setGlobalHint(`Focused window ${id}.`);
}

// =========================
// Backend calls
// =========================
async function fetchListing(path){
  const url = new URL(API_LIST, window.location.origin);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), { method:"GET" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

async function fetchFile(path){
  const url = new URL(API_FILE, window.location.origin);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), { method:"GET" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  const contentType = res.headers.get("Content-Type") || "application/octet-stream";
  const blob = await res.blob();
  return { blob, contentType, url: url.toString() };
}

// =========================
// Window actions
// =========================
async function ensureExplorerInFocused(){
  const w = getFocusedWin();
  if (!w) return;

  if (w.kind !== "explorer"){
    // If viewer had a blob, cleanup
    if (w.kind === "viewer" && w.viewer?.objectUrl){
      URL.revokeObjectURL(w.viewer.objectUrl);
    }
    // Convert window to explorer
    w.kind = "explorer";
    w.title = "Explorer";
    w.explorer = { cwd: DEFAULT_PATH, items: [], cursor: 0, loading: false, err: "" };
    delete w.viewer;
  }

  // Load listing if empty
  if (w.explorer.items.length === 0 && !w.explorer.loading){
    await loadExplorerListing(w, w.explorer.cwd);
  } else {
    render();
  }
}

async function loadExplorerListing(win, cwd){
  win.explorer.loading = true;
  win.explorer.err = "";
  win.explorer.cwd = cwd;
  render();

  try{
    const data = await fetchListing(cwd);
    const items = Array.isArray(data.items) ? data.items : [];
    // Sort: dirs first, then files, alpha
    items.sort((a,b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return String(a.name).localeCompare(String(b.name));
    });

    win.explorer.items = items;
    win.explorer.cursor = clamp(win.explorer.cursor, 0, Math.max(0, items.length - 1));
    win.explorer.loading = false;
    render();
    setGlobalHint(`Explorer loaded: ${data.path ?? cwd}`);
  } catch(err){
    win.explorer.loading = false;
    win.explorer.err = err.message || "Failed to load directory";
    render();
    setGlobalHint(`Explorer error: ${win.explorer.err}`);
  }
}

async function explorerMove(delta){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;
  const n = w.explorer.items.length;
  if (n === 0) return;
  w.explorer.cursor = clamp(w.explorer.cursor + delta, 0, n - 1);
  render();
  scrollCursorIntoView(w.id);
}

function scrollCursorIntoView(winId){
  const container = document.querySelector(`[data-win="${winId}"] .content`);
  if (!container) return;
  const sel = container.querySelector(`.entry.selected`);
  if (!sel) return;
  const selRect = sel.getBoundingClientRect();
  const contRect = container.getBoundingClientRect();
  if (selRect.top < contRect.top){
    sel.scrollIntoView({ block:"nearest" });
  } else if (selRect.bottom > contRect.bottom){
    sel.scrollIntoView({ block:"nearest" });
  }
}

async function explorerEnter(){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;

  const items = w.explorer.items;
  if (!items.length) return;

  const cur = items[w.explorer.cursor];
  if (!cur) return;

  // If this item came from search results, it has an absolute path
  if (cur.fullPath){
    if (cur.type === "dir"){
      await loadExplorerListing(w, cur.fullPath);
      return;
    }
    await openFileInWindow(w.id, cur.fullPath);
    return;
  }

  // Normal explorer listing path logic
  if (cur.type === "dir"){
    const next = joinPath(w.explorer.cwd, cur.name);
    await loadExplorerListing(w, next);
    return;
  }

  await openFileInWindow(w.id, joinPath(w.explorer.cwd, cur.name));
}

async function explorerUp(){
  const w = getFocusedWin();
  if (!w || w.kind !== "explorer") return;
  const up = parentPath(w.explorer.cwd);
  await loadExplorerListing(w, up);
}

async function openFileInWindow(winId, filePath){
  const w = state.windows.get(winId);
  if (!w) return;

  // Cleanup old viewer state
  if (w.kind === "viewer" && w.viewer?.objectUrl){
    URL.revokeObjectURL(w.viewer.objectUrl);
  }

  w.kind = "viewer";
  w.title = "Viewer";
  w.viewer = {
    path: filePath,
    contentType: "",
    objectUrl: null,
    text: "",
    pdfBlob: null,
    pdfZoom: 1.25,   // <--- add this line
  };
  delete w.explorer;

  render();
  focusPaneByWinId(winId);
  setGlobalHint(`Opening ${filePath}…`);

  try{
    const { blob, contentType } = await fetchFile(filePath);
    w.viewer.contentType = contentType;

    const ct = (contentType || "").toLowerCase();

    if (ct.includes("application/pdf")) {
      w.viewer.pdfBlob = blob;       // store the Blob, not ArrayBuffer

      render();
      focusPaneByWinId(winId);
      setGlobalHint(`Opened ${filePath}`);
      return;
    }

    // Text
    if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")){
      w.viewer.text = await blob.text();
      render();
      focusPaneByWinId(winId);
      setGlobalHint(`Opened ${filePath}`);
      return;
    }

    // Other binary: provide blob URL (optional)
    w.viewer.objectUrl = URL.createObjectURL(blob);
    render();
    focusPaneByWinId(winId);
    setGlobalHint(`Opened ${filePath}`);
  } catch(err){
    w.viewer.text = `Failed to open file:\n${err.message || err}`;
    w.viewer.contentType = "text/plain";
    render();
    focusPaneByWinId(winId);
    setGlobalHint(`Open failed: ${err.message || err}`);
  }
}

// =========================
// Rendering
// =========================
function render(){
  const ws = document.getElementById("workspace");
  ws.innerHTML = "";
  if (!state.root){
    ws.innerHTML = `<div class="emptyMsg">Internal error: no root.</div>`;
    return;
  }
  ws.appendChild(renderNode(state.root));
  updateCmdline();
  updateModePill();

  // After DOM is built, render all PDFs from state
  for (const w of state.windows.values()) {
    if (w.kind !== "viewer") continue;
    const v = w.viewer;
    const ct = (v.contentType || "").toLowerCase();
    if (!ct.includes("application/pdf")) continue;
    if (!v.pdfBlob) continue;

    const pane = document.querySelector(`[data-win="${w.id}"]`);
    if (!pane) continue;
    const content = pane.querySelector(".content");
    if (!content) continue;

    const zoom = v.pdfZoom || 1.25;        // default if missing
    renderPdfInto(content, v.pdfBlob, zoom);
  }
}

function updateModePill(){
  document.getElementById("modePill").textContent = state.mode.toUpperCase();
}

function renderNode(node){
  if (node.type === "leaf"){
    const w = state.windows.get(node.winId);
    return renderPane(w);
  }

  const el = document.createElement("div");
  el.className = `split ${node.dir}`;
  const childA = renderNode(node.a);
  const childB = renderNode(node.b);

  // flex-grow weights control how much space each side gets
  childA.style.flexGrow = String(node.wA ?? 1);
  childB.style.flexGrow = String(node.wB ?? 1);

  el.appendChild(childA);
  el.appendChild(childB);
  return el;
}

function focusPaneByWinId(winId) {
  requestAnimationFrame(() => {
    const pane = document.querySelector(`[data-win="${winId}"]`);
    if (pane) pane.focus();
  });
}

function renderPane(w){
  const pane = document.createElement("div");
  pane.tabIndex = 0;
  pane.className = "pane" + (w.id === state.focusId ? " focused" : "");
  pane.dataset.win = String(w.id);

  // click focus
  pane.addEventListener("mousedown", () => {
    if (state.focusId !== w.id){
      state.focusId = w.id;
      render();
    }
  });

  const status = document.createElement("div");
  status.className = "statusline";

  const left = document.createElement("div");
  left.className = "statusLeft";

  const wid = document.createElement("div");
  wid.className = "wid";
  wid.textContent = String(w.id);

  const wtype = document.createElement("div");
  wtype.className = "wtype " + w.kind;
  wtype.textContent =
    w.kind === "explorer" ? "EXPLORER" :
    w.kind === "viewer" ? "VIEWER" : "EMPTY";

  const title = document.createElement("div");
  title.className = "wtitle";

  if (w.kind === "explorer"){
    title.textContent = w.explorer.cwd;
  } else if (w.kind === "viewer"){
    title.textContent = w.viewer.path || "No file";
  } else {
    title.textContent = "No buffer";
  }

  left.appendChild(wid);
  left.appendChild(wtype);
  left.appendChild(title);

  const right = document.createElement("div");
  right.className = "statusRight";
  right.innerHTML = `<span>${state.focusId === w.id ? "FOCUS" : ""}</span>`;

  status.appendChild(left);
  status.appendChild(right);

  const content = document.createElement("div");
  content.className = "content";

  if (w.kind === "empty"){
    content.innerHTML = `
      <div class="emptyMsg">
        <div style="margin-bottom:10px;"><strong>Empty window</strong></div>
        <div style="margin-bottom:8px;">Try:</div>
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:10px;">
          <span class="kbd">Ctrl+N</span> <span class="kbd">:</span> <span class="kbd">vspl</span> <span class="kbd">spl</span> <span class="kbd">q</span>
        </div>
        <div>Focus windows with <span class="kbd">Ctrl+1</span>…<span class="kbd">Ctrl+9</span>.</div>
      </div>
    `;
  }

  if (w.kind === "explorer"){
    const ex = w.explorer;
    const header = document.createElement("div");
    header.className = "explorerHeader";
    header.innerHTML = `
      <div class="cwd">${escapeHtml(ex.cwd)}</div>
      <div class="smallHint">${ex.loading ? "loading…" : (ex.err ? "error" : "j/k, Enter")}</div>
    `;

    content.appendChild(header);

    if (ex.err){
      const err = document.createElement("div");
      err.className = "emptyMsg";
      err.style.borderColor = "rgba(239,68,68,0.35)";
      err.innerHTML = `<div style="color: rgba(239,68,68,0.9); font-weight:700; margin-bottom:6px;">Explorer error</div>
                       <div style="white-space:pre-wrap;">${escapeHtml(ex.err)}</div>`;
      content.appendChild(err);
    } else if (ex.loading && ex.items.length === 0){
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "Loading directory…";
      content.appendChild(msg);
    } else if (ex.items.length === 0){
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "Empty directory.";
      content.appendChild(msg);
    } else {
      const list = document.createElement("div");
      list.className = "list";

      ex.items.forEach((it, idx) => {
        const row = document.createElement("div");
        row.className = "entry" + (idx === ex.cursor ? " selected" : "");
        const iconText = it.type === "dir" ? "DIR" : "FILE";
        row.innerHTML = `
          <div class="icon ${it.type}">${iconText}</div>
          <div class="name">${escapeHtml(it.name)}</div>
          <div class="meta">${it.type}</div>
        `;

        // mouse click selects + double click enters/opens
        row.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          ex.cursor = idx;
          state.focusId = w.id;
          render();
        });
        row.addEventListener("dblclick", async () => {
          ex.cursor = idx;
          state.focusId = w.id;
          render();
          await explorerEnter();
        });

        list.appendChild(row);
      });

      content.appendChild(list);
    }
  }

  if (w.kind === "viewer") {
    const v = w.viewer;
    const ct = (v.contentType || "").toLowerCase();

    if (ct.includes("application/pdf")) {
      // Leave content empty here; render() will call renderPdfInto()
      // once the whole layout is built.
    } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || v.text) {
      const pre = document.createElement("pre");
      pre.textContent = v.text || "";
      content.appendChild(pre);
    } else if (v.objectUrl) {
      const frame = document.createElement("iframe");
      frame.title = "File preview";
      frame.src = v.objectUrl;
      frame.tabIndex = -1;
      content.appendChild(frame);
    } else {
      const msg = document.createElement("div");
      msg.className = "emptyMsg";
      msg.textContent = "No preview available.";
      content.appendChild(msg);
    }
  }

  pane.appendChild(status);
  pane.appendChild(content);
  return pane;
}

// =========================
// Command execution
// =========================
function execCommand(raw){
  const cmd = (raw || "").trim();
  state.cmdErr = "";

  if (!cmd){
    setGlobalHint("");
    return;
  }

  // Simple commands: q, spl, vspl
  if (cmd === "q"){
    removeFocusedWindow();
    return;
  }
  if (cmd === "spl"){
    splitFocused("h");
    return;
  }
  if (cmd === "vspl"){
    splitFocused("v");
    return;
  }

  state.cmdErr = `E492: Not an editor command: ${cmd}`;
  setGlobalHint(state.cmdErr);
  updateCmdline();
}

// =========================
// Key handling
// =========================
function isTypingTarget(ev){
  // We don't use inputs, but keep this for safety
  const t = ev.target;
  if (!t) return false;
  const tag = (t.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || t.isContentEditable;
}

window.addEventListener("keydown", async (ev) => {
  // Don't hijack keys while user is in a text input (future-proof)
  if (isTypingTarget(ev)) return;

  if (state.mode === "search"){
    ev.preventDefault();

    if (ev.key === "Escape"){
      state.search = "";
      state.searchErr = "";
      setMode("normal");
      setGlobalHint("");
      return;
    }

    if (ev.key === "Enter"){
      const w = getFocusedWin();
      if (!w || w.kind !== "explorer") return;

      const query = state.search.trim();
      state.search = "";
      setMode("normal");

      if (!query){
        setGlobalHint("Empty search");
        return;
      }

      await runExplorerSearch(w, query);
      return;
    }

    if (ev.key === "Backspace"){
      state.search = state.search.slice(0, -1);
      updateCmdline();
      return;
    }

    if (ev.key.length === 1){
      state.search += ev.key;
      updateCmdline();
      return;
    }

    return;
  }

  // Command mode behavior
  if (state.mode === "command"){
    ev.preventDefault();

    if (ev.key === "Escape"){
      state.cmd = "";
      state.cmdErr = "";
      setMode("normal");
      setGlobalHint("");
      return;
    }
    if (ev.key === "Enter"){
      const toRun = state.cmd;
      state.cmd = "";
      setMode("normal");
      execCommand(toRun);
      return;
    }
    if (ev.key === "Backspace"){
      state.cmd = state.cmd.slice(0, -1);
      updateCmdline();
      return;
    }
    if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey){
      state.cmd += ev.key;
      updateCmdline();
      return;
    }

    return;
  }

  // Normal mode
  // Focus window with Ctrl+1..9
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey){
    const digit = ev.key;
    if (digit >= "1" && digit <= "9"){
      ev.preventDefault();
      focusWindow(Number(digit));
      return;
    }
  }

  // "/" → enter recursive search (explorer only)
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "/"){
    const w = getFocusedWin();
    if (!w || w.kind !== "explorer") return;

    ev.preventDefault();
    state.search = "";
    state.searchErr = "";
    setMode("search");
    setGlobalHint("Search (recursive)");
    return;
  }

  // Ctrl+N: open explorer in focused window
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "n" || ev.key === "N")){
    ev.preventDefault();
    await ensureExplorerInFocused();
    return;
  }

  // Ctrl+B: go up (explorer only)
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "b" || ev.key === "B")){
    ev.preventDefault();
    const w = getFocusedWin();
    if (!w) return;

    if (w.kind === "explorer") {
      await explorerUp();
    } else if (w.kind === "viewer") {
      await viewerBackToExplorer();
    }
    return;
  }

  // ":" enters command mode
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === ":"){
    ev.preventDefault();
    state.cmd = "";
    state.cmdErr = "";
    setMode("command");
    setGlobalHint("COMMAND");
    return;
  }

  // Zoom PDF viewer: "+" to zoom in, "-" to zoom out
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey &&
      (ev.key === "+" || ev.key === "-" || ev.key === "=")) {
    console.log("ehlloe");

    const w = getFocusedWin();
    if (!w || w.kind !== "viewer") return;

    const ct = (w.viewer?.contentType || "").toLowerCase();
    if (!ct.includes("application/pdf")) return; // only for PDFs

    ev.preventDefault();

    // Normal keyboards send "=" with Shift for "+"; treat "=" with Shift as "+"
    const isPlus = (ev.key === "+") || (ev.key === "=" && ev.shiftKey);
    const isMinus = (ev.key === "-");

    let zoom = w.viewer.pdfZoom || 1.25;
    const step = 0.25;

    if (isPlus) {
      zoom = Math.min(zoom + step, 4.0);  // max 4x
    } else if (isMinus) {
      zoom = Math.max(zoom - step, 0.5);  // min 0.5x
    } else {
      return;
    }

    w.viewer.pdfZoom = zoom;
    setGlobalHint(`PDF zoom: ${zoom.toFixed(2)}x`);
    render(); // re-render layout and PDF at new zoom
    return;
  }

  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey &&
      (ev.key === "h" || ev.key === "j" || ev.key === "k" || ev.key === "l")) {

    const w = getFocusedWin();
    if (!w) return;

    // Explorer: only j/k move selection
    if (w.kind === "explorer"){
      if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        await explorerMove(ev.key === "j" ? +1 : -1);
      }
      return;
    }

    // Viewer: h/j/k/l scroll
    if (w.kind === "viewer"){
      ev.preventDefault();

      const vStep = 48;  // pixels per j/k
      const hStep = 64;  // pixels per h/l

      if (ev.key === "j") scrollFocusedViewerXY(0, +vStep);
      if (ev.key === "k") scrollFocusedViewerXY(0, -vStep);
      if (ev.key === "l") scrollFocusedViewerXY(+hStep, 0);
      if (ev.key === "h") scrollFocusedViewerXY(-hStep, 0);

      return;
    }

    return;
  }

  // Resize keymaps: require Shift (so Shift+j => "J"), not Caps Lock.
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.shiftKey &&
      (ev.key === "H" || ev.key === "L" || ev.key === "J" || ev.key === "K")) {

    ev.preventDefault();
    const step = 0.15;

    if (ev.key === "H") resizeFocused("v", -step);
    if (ev.key === "L") resizeFocused("v", +step);
    if (ev.key === "J") resizeFocused("h", -step);
    if (ev.key === "K") resizeFocused("h", +step);

    return;
  }

  // Enter (explorer only)
  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key === "Enter"){
    const w = getFocusedWin();
    if (w && w.kind === "explorer"){
      ev.preventDefault();
      await explorerEnter();
    }
    return;
  }
});

function clearViewerNode(viewerEl) {
  // remove old canvases / content
  viewerEl.innerHTML = "";
}

function makePdfContainer() {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.flexDirection = "column";
  wrap.style.alignItems = "center";   // center pages
  wrap.style.gap = "12px";
  wrap.style.padding = "10px";
  wrap.style.width = "fit-content";
  wrap.style.maxWidth = "none";
  return wrap;
}

async function renderPdfInto(viewerEl, pdfBlob, zoom) {
  clearViewerNode(viewerEl);
  viewerEl.style.overflow = "auto";

  const pdfWrap = makePdfContainer();
  viewerEl.appendChild(pdfWrap);

  const loading = document.createElement("div");
  loading.textContent = "Rendering PDF…";
  loading.style.fontFamily = "var(--mono)";
  loading.style.color = "rgba(255,255,255,0.65)";
  loading.style.padding = "6px 2px";
  pdfWrap.appendChild(loading);

  const arrayBuffer = await pdfBlob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  loading.textContent = `PDF loaded (${pdf.numPages} pages). Rendering…`;

  const scale = zoom || 1.25;   // <--- use zoom argument

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);


    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.style.border = "1px solid rgba(255,255,255,0.12)";
    canvas.style.borderRadius = "10px";
    canvas.style.background = "rgba(0,0,0,0.12)";

    const label = document.createElement("div");
    label.textContent = `Page ${pageNum}/${pdf.numPages}`;
    label.style.fontFamily = "var(--mono)";
    label.style.fontSize = "12px";
    label.style.color = "rgba(255,255,255,0.55)";
    label.style.margin = "2px 2px -2px";

    pdfWrap.appendChild(label);
    pdfWrap.appendChild(canvas);

    await page.render({ canvasContext: ctx, viewport }).promise;
    await new Promise(requestAnimationFrame);
  }

  loading.remove();
}

async function viewerBackToExplorer() {
  const w = getFocusedWin();
  if (!w || w.kind !== "viewer") return;

  const filePath = w.viewer?.path || "/";
  const dir = parentPath(filePath); // uses your existing parentPath()

  // Cleanup any blob url
  if (w.viewer?.pdfBlob) {
    w.viewer.pdfBlob = null;
  }

  // Convert to explorer at the file's directory
  w.kind = "explorer";
  w.title = "Explorer";
  w.explorer = { cwd: dir, items: [], cursor: 0, loading: false, err: "" };
  delete w.viewer;

  render();
  focusPaneByWinId(w.id);
  await loadExplorerListing(w, dir);
}

async function fetchSearch(basePath, q){
  const url = new URL(API_SEARCH, window.location.origin);
  url.searchParams.set("path", basePath);
  url.searchParams.set("q", q);
  const res = await fetch(url.toString(), { method: "GET" });
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(txt || `HTTP ${res.status}`);
  }
  return res.json();
}

async function runExplorerSearch(win, query){
  win.explorer.loading = true;
  render();

  try{
    const url = new URL("/api/search", window.location.origin);
    url.searchParams.set("path", win.explorer.cwd);
    url.searchParams.set("q", query);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(await res.text());

    const data = await res.json();

    win.explorer.items = data.matches.map(m => ({
      name: m.path.split("/").pop(),
      type: m.type,
      fullPath: m.path,
    }));

    win.explorer.cursor = 0;
    win.explorer.loading = false;

    setGlobalHint(`${win.explorer.items.length} match(es)`);
    render();
  } catch (err){
    win.explorer.loading = false;
    win.explorer.err = err.message || "Search failed";
    render();
  }
}

function setPrompt(ch){
  const p = document.getElementById("cmdprompt");
  if (p) p.textContent = ch;
}

// =========================
// Init
// =========================
function init(){
  // Start with one empty window
  const w = makeWindow("empty");
  state.root = makeLeaf(w.id);
  state.focusId = w.id;

  setGlobalHint("Ready. Ctrl+N to open explorer. ':' for commands.");
  render();
}

init();
