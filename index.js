
// =========================
// Backend API endpoints
// =========================
const API_LIST = "/api/list";
const API_FILE = "/api/file";

// Client "root" path - your backend can interpret "/" however you want
const DEFAULT_PATH = "/";

// =========================
// State (editor-like)
// =========================
const state = {
  mode: "normal",         // "normal" | "command"
  cmd: "",
  cmdErr: "",
  nextId: 1,
  focusId: null,

  // Split tree root
  root: null,

  // Windows dictionary
  windows: new Map(), // id -> window object
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
  document.getElementById("cmdtext").textContent = state.cmd;
  document.getElementById("cmderr").textContent = state.cmdErr || "";
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

  const px = deltaLines * 28; // scroll step (px); tweak to taste

  // If there's an iframe (PDF), try to scroll inside it.
  const frame = content.querySelector("iframe");
  if (frame && frame.contentWindow){
    frame.contentWindow.scrollBy(0, px);
    return true;
  }

  // Otherwise scroll the content container (text viewer lives here)
  content.scrollBy({ top: px, behavior: "auto" });
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
  state.focusId = id;
  render(); // just to update focus highlight/status
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

  if (cur.type === "dir"){
    const next = joinPath(w.explorer.cwd, cur.name);
    await loadExplorerListing(w, next);
    return;
  }

  // open file in the same window (convert to viewer)
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

  // Convert window to viewer
  // Cleanup old blob URL if exists
  if (w.kind === "viewer" && w.viewer?.objectUrl){
    URL.revokeObjectURL(w.viewer.objectUrl);
  }

  w.kind = "viewer";
  w.title = "Viewer";
  w.viewer = { path: filePath, contentType: "", objectUrl: null, text: "" };
  delete w.explorer;

  render();
  setGlobalHint(`Opening ${filePath}…`);

  try{
    const { blob, contentType } = await fetchFile(filePath);
    w.viewer.contentType = contentType;

    const ct = (contentType || "").toLowerCase();
    if (ct.includes("application/pdf")){
      w.viewer.objectUrl = URL.createObjectURL(blob);
    } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml")){
      w.viewer.text = await blob.text();
    } else {
      // fallback: still provide blob URL so user can open in a new tab later if you add it
      w.viewer.objectUrl = URL.createObjectURL(blob);
    }

    render();
    setGlobalHint(`Opened ${filePath}`);
  } catch(err){
    // show error inside viewer
    w.viewer.text = `Failed to open file:\n${err.message || err}`;
    w.viewer.contentType = "text/plain";
    render();
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

function renderPane(w){
  const pane = document.createElement("div");
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

  if (w.kind === "viewer"){
    const v = w.viewer;
    const ct = (v.contentType || "").toLowerCase();

    if (ct.includes("application/pdf") && v.objectUrl){
      const frame = document.createElement("iframe");
      frame.title = "PDF preview";
      frame.src = v.objectUrl;
      content.appendChild(frame);
    } else if (ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || v.text){
      const pre = document.createElement("pre");
      pre.textContent = v.text || "";
      content.appendChild(pre);
    } else if (v.objectUrl){
      // Fallback: show in iframe anyway
      const frame = document.createElement("iframe");
      frame.title = "File preview";
      frame.src = v.objectUrl;
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

  // Ctrl+N: open explorer in focused window
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "n" || ev.key === "N")){
    ev.preventDefault();
    await ensureExplorerInFocused();
    return;
  }

  // Ctrl+B: go up (explorer only)
  if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && (ev.key === "b" || ev.key === "B")){
    ev.preventDefault();
    await explorerUp();
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

  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && (ev.key === "j" || ev.key === "k")){
    const w = getFocusedWin();
    if (!w) return;

    // Explorer: move cursor
    if (w.kind === "explorer"){
      ev.preventDefault();
      await explorerMove(ev.key === "j" ? +1 : -1);
      return;
    }

    // Viewer: scroll
    if (w.kind === "viewer"){
      ev.preventDefault();
      scrollFocusedViewer(ev.key === "j" ? +1 : -1);
      return;
    }

    return;
  }

  if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && !ev.shiftKey &&
      (ev.key === "H" || ev.key === "L" || ev.key === "J" || ev.key === "K")) {

    ev.preventDefault();
    const step = 0.15; // tweak to taste

    if (ev.key === "H") resizeFocused("v", -step); // shrink width
    if (ev.key === "L") resizeFocused("v", +step); // grow width
    if (ev.key === "J") resizeFocused("h", -step); // shrink height
    if (ev.key === "K") resizeFocused("h", +step); // grow height

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
